import dotenv from "dotenv";

// Load environment variables before importing services that read env.
dotenv.config({ path: [".env.local", ".env"] });

async function run() {
  const fileId = process.argv[2];
  if (!fileId) {
    console.error("Usage: npm run diagnose -- <fileId>");
    process.exit(1);
  }

  const { GoogleDriveService } = await import("@/services/googleDrive.service");
  const drive = new GoogleDriveService();

  try {
    const info = await drive.getFileDiagnostics(fileId);
    console.log(JSON.stringify(info, null, 2));
  } catch (error) {
    console.error("Failed to fetch diagnostics:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

run();
