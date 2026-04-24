import { Payment, Invoice, Prisma } from "@prisma/client";
import { getPrismaClient } from "@/lib/prisma";

export interface CreatePaymentInput {
  clientId: string;
  invoiceId: string;
  amount: Prisma.Decimal | number;
  paymentDate: Date;
  installmentNumber?: number;
  totalInstallments?: number;
  driveFileId?: string | null;
  driveFileUrl?: string | null;
  paymentMethod?: string | null;
  observation?: string;
}

export class PaymentRepository {
  async getPaymentsByInvoiceId(
    invoiceId: string,
    clientId: string
  ): Promise<Payment[]> {
    const prisma = getPrismaClient();
    return prisma.payment.findMany({
      where: { invoiceId, clientId },
      orderBy: { createdAt: "asc" },
    });
  }

  async createPayment(
    input: CreatePaymentInput
  ): Promise<{ payment: Payment; invoice: Invoice }> {
    const prisma = getPrismaClient();

    return prisma.$transaction(async (tx) => {
      // 1. Obtener invoice con lock implícito via transacción
      const invoice = await tx.invoice.findUniqueOrThrow({
        where: { id: input.invoiceId },
      });

      // 2. Validar pertenencia al cliente
      if (invoice.clientId !== input.clientId) {
        throw new PaymentError("La boleta no pertenece al cliente", 403);
      }

      // 3. Validar que no esté pagada
      if (invoice.isPaid) {
        throw new PaymentError("La boleta ya está completamente pagada", 409);
      }

      // 4. Validar que la invoice tenga monto
      if (invoice.amount === null) {
        throw new PaymentError("La boleta no tiene monto definido", 400);
      }

      const invoiceAmount = new Prisma.Decimal(invoice.amount.toString());

      // 5. Buscar pagos previos para determinar el modo
      const existingPayments = await tx.payment.findMany({
        where: { invoiceId: input.invoiceId },
        orderBy: { createdAt: "asc" },
      });

      const isFirstPayment = existingPayments.length === 0;

      // 6. Validar consistencia de modo
      if (!isFirstPayment) {
        const hadInstallments = existingPayments[0].totalInstallments !== null;
        const wantsInstallments = input.totalInstallments !== undefined;

        if (hadInstallments && !wantsInstallments) {
          throw new PaymentError(
            "Esta boleta usa modo cuotas. Debe continuar con cuotas.",
            409
          );
        }
        if (!hadInstallments && wantsInstallments) {
          throw new PaymentError(
            "Esta boleta usa modo pago libre. No se pueden agregar cuotas.",
            409
          );
        }
      }

      // 7. Calcular monto efectivo
      let effectiveAmount: Prisma.Decimal;
      let installmentNumber: number | null = null;
      let totalInstallments: number | null = null;

      if (input.totalInstallments !== undefined || (!isFirstPayment && existingPayments[0].totalInstallments !== null)) {
        // Modo cuotas
        totalInstallments = input.totalInstallments ?? existingPayments[0].totalInstallments!;
        installmentNumber = isFirstPayment ? 1 : existingPayments.length + 1;

        if (installmentNumber > totalInstallments) {
          throw new PaymentError(
            `Ya se registraron todas las cuotas (${totalInstallments})`,
            409
          );
        }

        // Último pago absorbe redondeo
        if (installmentNumber === totalInstallments) {
          const currentRemaining = isFirstPayment
            ? invoiceAmount
            : new Prisma.Decimal(invoice.remainingBalance!.toString());
          effectiveAmount = currentRemaining;
        } else {
          effectiveAmount = invoiceAmount
            .div(totalInstallments)
            .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
        }
      } else {
        // Modo libre
        effectiveAmount = new Prisma.Decimal(input.amount.toString());
      }

      // 8. Calcular nuevo remainingBalance
      const currentRemaining = isFirstPayment
        ? invoiceAmount
        : new Prisma.Decimal(invoice.remainingBalance!.toString());

      let newRemaining = currentRemaining.minus(effectiveAmount);
      if (newRemaining.lessThanOrEqualTo(0)) {
        newRemaining = new Prisma.Decimal(0);
      }

      const isPaid = newRemaining.equals(0);

      // 9. Crear payment + actualizar invoice
      const payment = await tx.payment.create({
        data: {
          clientId: input.clientId,
          invoiceId: input.invoiceId,
          amount: effectiveAmount,
          paymentDate: input.paymentDate,
          installmentNumber,
          totalInstallments,
          driveFileId: input.driveFileId ?? null,
          driveFileUrl: input.driveFileUrl ?? null,
          paymentMethod: input.paymentMethod ?? null,
          observation: input.observation ?? null,
        },
      });

      const updatedInvoice = await tx.invoice.update({
        where: { id: input.invoiceId },
        data: {
          isPaid,
          remainingBalance: newRemaining,
        },
      });

      return { payment, invoice: updatedInvoice };
    });
  }

  async deletePayment(
    paymentId: string,
    clientId: string
  ): Promise<void> {
    const prisma = getPrismaClient();

    await prisma.$transaction(async (tx) => {
      // Obtener el payment a eliminar
      const payment = await tx.payment.findUnique({
        where: { id: paymentId },
      });

      if (!payment) {
        throw new PaymentError("Pago no encontrado", 404);
      }

      if (payment.clientId !== clientId) {
        throw new PaymentError("El pago no pertenece al cliente", 403);
      }

      // Verificar que sea el último pago de la invoice
      const allPayments = await tx.payment.findMany({
        where: { invoiceId: payment.invoiceId },
        orderBy: { createdAt: "desc" },
      });

      if (allPayments.length === 0 || allPayments[0].id !== paymentId) {
        throw new PaymentError(
          "Solo se puede eliminar el último pago registrado",
          409
        );
      }

      // Eliminar el payment
      await tx.payment.delete({ where: { id: paymentId } });

      // Recalcular invoice
      if (allPayments.length === 1) {
        // Era el único pago
        await tx.invoice.update({
          where: { id: payment.invoiceId },
          data: { isPaid: false, remainingBalance: null },
        });
      } else {
        // Había pagos previos — sumar el monto eliminado al remainingBalance
        const invoice = await tx.invoice.findUniqueOrThrow({
          where: { id: payment.invoiceId },
        });

        const currentRemaining = new Prisma.Decimal(
          invoice.remainingBalance?.toString() ?? "0"
        );
        const newRemaining = currentRemaining.plus(
          new Prisma.Decimal(payment.amount.toString())
        );

        await tx.invoice.update({
          where: { id: payment.invoiceId },
          data: {
            isPaid: false,
            remainingBalance: newRemaining,
          },
        });
      }
    });
  }
}

export class PaymentError extends Error {
  public statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "PaymentError";
    this.statusCode = statusCode;
  }
}
