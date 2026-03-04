import dotenv from "dotenv";

type EnvShape = {
  PROCESS_INTERVAL_MINUTES: string;
};

type ParseIntervalFn = (value: string) => number;
type RunCycleFn = (trigger: "schedule", options?: { clientId?: string }) => Promise<unknown>;
type ControlCtor = new () => {
  getState: (intervalMinutes: number, clientId?: string) => Promise<{ enabled: boolean }>;
  touchHeartbeat: (intervalMinutes: number, clientId?: string) => Promise<unknown>;
};
type ClientRepositoryCtor = new () => {
  listActiveClients: () => Promise<Array<{ id: string; name: string }>>;
};

function resolveEnvModule(module: unknown): EnvShape {
  const candidate = module as {
    env?: EnvShape;
    default?: { env?: EnvShape };
    "module.exports"?: { env?: EnvShape };
  };

  const resolved = candidate.env ?? candidate.default?.env ?? candidate["module.exports"]?.env;
  if (!resolved) {
    throw new Error("Failed to resolve env export from @/config/env");
  }

  return resolved;
}

function resolveRunHelpers(module: unknown): { parseInterval: ParseIntervalFn; runCycle: RunCycleFn } {
  const candidate = module as {
    parseProcessIntervalMinutes?: ParseIntervalFn;
    runProcessingCycle?: RunCycleFn;
    default?: {
      parseProcessIntervalMinutes?: ParseIntervalFn;
      runProcessingCycle?: RunCycleFn;
    };
    "module.exports"?: {
      parseProcessIntervalMinutes?: ParseIntervalFn;
      runProcessingCycle?: RunCycleFn;
    };
  };

  const parseInterval =
    candidate.parseProcessIntervalMinutes ??
    candidate.default?.parseProcessIntervalMinutes ??
    candidate["module.exports"]?.parseProcessIntervalMinutes;

  const runCycle =
    candidate.runProcessingCycle ??
    candidate.default?.runProcessingCycle ??
    candidate["module.exports"]?.runProcessingCycle;

  if (!parseInterval || !runCycle) {
    throw new Error("Failed to resolve scheduler helpers from @/jobs/runProcessingCycle");
  }

  return { parseInterval, runCycle };
}

function resolveControlService(module: unknown): ControlCtor {
  const candidate = module as {
    SchedulerControlService?: ControlCtor;
    default?: { SchedulerControlService?: ControlCtor };
    "module.exports"?: { SchedulerControlService?: ControlCtor };
  };

  const ctor =
    candidate.SchedulerControlService ??
    candidate.default?.SchedulerControlService ??
    candidate["module.exports"]?.SchedulerControlService;

  if (!ctor) {
    throw new Error("Failed to resolve SchedulerControlService export");
  }

  return ctor;
}

function resolveClientRepository(module: unknown): ClientRepositoryCtor {
  const candidate = module as {
    ClientRepository?: ClientRepositoryCtor;
    default?: { ClientRepository?: ClientRepositoryCtor };
    "module.exports"?: { ClientRepository?: ClientRepositoryCtor };
  };

  const ctor =
    candidate.ClientRepository ??
    candidate.default?.ClientRepository ??
    candidate["module.exports"]?.ClientRepository;

  if (!ctor) {
    throw new Error("Failed to resolve ClientRepository export");
  }

  return ctor;
}

type AggregateSummary = {
  totalFound: number;
  processed: number;
  skipped: number;
  failed: number;
  duplicatesDetected: number;
  errors: Array<{ fileId: string; fileName: string; error: string }>;
};

function createAggregateSummary(): AggregateSummary {
  return {
    totalFound: 0,
    processed: 0,
    skipped: 0,
    failed: 0,
    duplicatesDetected: 0,
    errors: [],
  };
}

function addSummary(aggregate: AggregateSummary, input: unknown): void {
  if (!input || typeof input !== "object") {
    return;
  }

  const source = input as Record<string, unknown>;

  const totalFound = Number(source.totalFound);
  const processed = Number(source.processed);
  const skipped = Number(source.skipped);
  const failed = Number(source.failed);
  const duplicatesDetected = Number(source.duplicatesDetected);

  aggregate.totalFound += Number.isFinite(totalFound) ? totalFound : 0;
  aggregate.processed += Number.isFinite(processed) ? processed : 0;
  aggregate.skipped += Number.isFinite(skipped) ? skipped : 0;
  aggregate.failed += Number.isFinite(failed) ? failed : 0;
  aggregate.duplicatesDetected += Number.isFinite(duplicatesDetected) ? duplicatesDetected : 0;

  if (Array.isArray(source.errors)) {
    for (const errorItem of source.errors) {
      if (!errorItem || typeof errorItem !== "object") {
        continue;
      }

      const row = errorItem as Record<string, unknown>;
      aggregate.errors.push({
        fileId: typeof row.fileId === "string" ? row.fileId : "unknown",
        fileName: typeof row.fileName === "string" ? row.fileName : "unknown",
        error: typeof row.error === "string" ? row.error : "Unknown error",
      });
    }
  }
}

async function runScheduler() {
  dotenv.config({ path: [".env.local", ".env"] });

  try {
    const [envModule, cycleModule, controlModule, clientRepositoryModule] = await Promise.all([
      import("@/config/env"),
      import("@/jobs/runProcessingCycle"),
      import("@/services/schedulerControl.service"),
      import("@/repositories/client.repository"),
    ]);

    const env = resolveEnvModule(envModule);
    const { parseInterval, runCycle } = resolveRunHelpers(cycleModule);
    const SchedulerControlService = resolveControlService(controlModule);
    const ClientRepository = resolveClientRepository(clientRepositoryModule);
    const controlService = new SchedulerControlService();
    const clientRepository = new ClientRepository();

    const minutes = parseInterval(env.PROCESS_INTERVAL_MINUTES);
    const intervalMs = minutes * 60 * 1000;

    let localRunning = false;

    const runOnce = async () => {
      if (localRunning) {
        return;
      }

      localRunning = true;

      try {
        const clients = await clientRepository.listActiveClients();
        if (clients.length === 0) {
          console.log("[scheduler] no active clients to process");
          return;
        }

        const aggregate = createAggregateSummary();

        for (const client of clients) {
          await controlService.touchHeartbeat(minutes, client.id);
          const clientState = await controlService.getState(minutes, client.id);

          if (!clientState.enabled) {
            console.log(`[scheduler] client paused clientId=${client.id} name="${client.name}"`);
            continue;
          }

          try {
            const clientSummary = await runCycle("schedule", { clientId: client.id });
            addSummary(aggregate, clientSummary);
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error";
            console.error(
              `[scheduler] client failed clientId=${client.id} name="${client.name}" error=${message}`
            );
            aggregate.failed += 1;
            aggregate.errors.push({
              fileId: `client:${client.id}`,
              fileName: client.name,
              error: message,
            });
          }
        }

        console.log("[scheduler] completed", aggregate);
      } catch (error) {
        console.error(
          "[scheduler] failed",
          error instanceof Error ? error.message : "Unknown error"
        );
      } finally {
        localRunning = false;
      }
    };

    console.log(`[scheduler] starting. Interval: ${minutes} minutes`);
    await runOnce();
    setInterval(runOnce, intervalMs);
  } catch (error) {
    console.error(
      "[scheduler] bootstrap failed",
      error instanceof Error ? error.message : "Unknown error"
    );
    process.exit(1);
  }
}

void runScheduler();
