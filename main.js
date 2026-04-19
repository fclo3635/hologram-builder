const { app, BrowserWindow } = require("electron");
const { spawn, exec } = require("child_process");
const path = require("path");
const fs = require("fs");

let pyProcess = null;

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

// Detect dev vs packaged
const isDev = !app.isPackaged;

// Resolve paths
function getPaths() {
  if (isDev) {
    return {
      python: path.join(__dirname, "backend/venv/Scripts/python.exe"),
      script: path.join(__dirname, "backend/app/main.py")
    };
  } else {
    return {
      python: path.join(process.resourcesPath, "backend/venv/Scripts/python.exe"),
      script: path.join(process.resourcesPath, "backend/app/main.py")
    };
  }
}

// Start Python backend
function startPython() {
  const { python, script } = getPaths();

  console.log("PYTHON PATH:", python);
  console.log("SCRIPT PATH:", script);

  // Check existence (important debug)
  if (!fs.existsSync(python)) {
    console.error("❌ Python not found:", python);
    return;
  }

  if (!fs.existsSync(script)) {
    console.error("❌ Script not found:", script);
    return;
  }

  pyProcess = spawn(python, [script, "--no-preview"], {
   cwd: path.dirname(script),
   env: {
    ...process.env,
    PYTHONPATH: path.join(process.resourcesPath, "backend/venv/Lib/site-packages")
  }
 });

  pyProcess.stderr.on("data", (data) => {
    console.error(`PYTHON ERROR: ${data}`);
    
    // Save error log for debugging
    fs.appendFileSync("error.log", data.toString());
  });

  pyProcess.on("close", (code) => {
    console.log(`Python exited with code ${code}`);
  });
}

// Create Electron window
function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      contextIsolation: true
    }
  });

  win.loadFile(require("path").join(__dirname, "web/index.html"));
}

// App start
app.whenReady().then(() => {
  startPython();

  // Wait for backend server to start
  setTimeout(() => {
    createWindow();
  }, 2500);
});

// Proper shutdown
app.on("will-quit", () => {
  if (pyProcess) {
    pyProcess.kill("SIGTERM");

    // Force kill (Windows fix)
    exec("taskkill /F /IM python.exe");
  }
});