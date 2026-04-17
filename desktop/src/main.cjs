"use strict";

const { app, BrowserWindow, Menu, Tray, shell } = require("electron");
const childProcess = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const { createIcon } = require("./icons.cjs");
const {
  backendDir,
  backendExecutable,
  configPath,
  frontendDistDir,
  logsDir,
  projectRoot,
  pythonExecutable,
} = require("./paths.cjs");

const HOST = process.env.QUOKKA_BACKEND_HOST ?? "127.0.0.1";
const PORT = Number(process.env.QUOKKA_BACKEND_PORT ?? "8000");
const APP_URL = `http://${HOST}:${PORT}/`;
const HEALTH_URL = `http://${HOST}:${PORT}/api/system/health`;
const MODELS_URL = `http://${HOST}:${PORT}/api/models`;

let mainWindow = null;
let tray = null;
let backendProcess = null;
let ownsBackend = false;
let quitting = false;
let lastTrayTone = "normal";
let lastModelCount = 0;
let lastRunningModelCount = 0;

const singleInstanceLock = app.requestSingleInstanceLock();

if (!singleInstanceLock) {
  app.quit();
}

app.on("second-instance", () => {
  showWindow();
});

function requestJson(url, timeoutMs = 1800) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
          try {
            resolve(body ? JSON.parse(body) : {});
          } catch (error) {
            reject(error);
          }
        } else {
          reject(new Error(`HTTP ${response.statusCode}`));
        }
      });
    });

    request.on("timeout", () => {
      request.destroy(new Error("Request timed out"));
    });
    request.on("error", reject);
  });
}

async function isBackendOnline() {
  try {
    await requestJson(HEALTH_URL);
    return true;
  } catch {
    return false;
  }
}

async function waitForBackend(timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isBackendOnline()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function backendEnvironment() {
  return {
    ...process.env,
    QUOKKA_PROJECT_ROOT: projectRoot(),
    QUOKKA_CONFIG_PATH: configPath(),
    QUOKKA_LOGS_DIR: logsDir(),
    QUOKKA_FRONTEND_DIST: frontendDistDir(),
    QUOKKA_BACKEND_HOST: HOST,
    QUOKKA_BACKEND_PORT: String(PORT),
    PYTHONUNBUFFERED: "1",
  };
}

async function startBackend() {
  if (await isBackendOnline()) {
    ownsBackend = false;
    return true;
  }

  const executable = backendExecutable();
  const env = backendEnvironment();

  if (executable) {
    backendProcess = childProcess.spawn(executable, ["--host", HOST, "--port", String(PORT)], {
      cwd: backendDir(),
      env,
      windowsHide: true,
      stdio: "ignore",
    });
  } else {
    const python = pythonExecutable();
    if (!python) {
      throw new Error("No backend executable or Python interpreter was found.");
    }

    backendProcess = childProcess.spawn(
      python,
      ["-m", "uvicorn", "app.main:app", "--host", HOST, "--port", String(PORT)],
      {
        cwd: backendDir(),
        env,
        windowsHide: true,
        stdio: "ignore",
      }
    );
  }

  ownsBackend = true;
  backendProcess.once("exit", () => {
    backendProcess = null;
    if (!quitting) {
      updateTray("danger");
    }
  });

  return waitForBackend();
}

function stopBackend() {
  if (!backendProcess || !ownsBackend) {
    return;
  }

  try {
    if (process.platform === "win32") {
      childProcess.spawnSync("taskkill", ["/PID", String(backendProcess.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      backendProcess.kill("SIGTERM");
    }
  } catch {
    backendProcess.kill();
  } finally {
    backendProcess = null;
  }
}

async function restartBackend() {
  stopBackend();
  updateTray("warning");
  await startBackend();
  if (mainWindow) {
    await mainWindow.loadURL(APP_URL);
  }
  await refreshTrayState();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 760,
    title: "Quokka",
    backgroundColor: "#11110f",
    icon: createIcon(lastTrayTone),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.loadURL(APP_URL);
}

function showWindow() {
  if (!mainWindow) {
    createWindow();
  }
  mainWindow.show();
  mainWindow.focus();
}

function updateTray(tone = "normal") {
  lastTrayTone = tone;
  if (!tray) {
    return;
  }
  tray.setImage(createIcon(tone));
  tray.setToolTip(`Quokka - ${lastRunningModelCount} running / ${lastModelCount} configured`);
  tray.setContextMenu(buildTrayMenu());
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: "Open Quokka",
      click: showWindow,
    },
    {
      label: `Backend: ${backendProcess || ownsBackend ? "Managed" : "Connected"}`,
      enabled: false,
    },
    {
      label: `Models: ${lastRunningModelCount} running / ${lastModelCount} configured`,
      enabled: false,
    },
    { type: "separator" },
    {
      label: "Open logs",
      click: () => shell.openPath(logsDir()),
    },
    {
      label: "Restart backend",
      click: () => {
        restartBackend().catch(() => updateTray("danger"));
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
}

function createTray() {
  tray = new Tray(createIcon("normal"));
  tray.setToolTip("Quokka");
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", showWindow);
  tray.on("double-click", showWindow);
}

async function refreshTrayState() {
  try {
    const models = await requestJson(MODELS_URL);
    if (!Array.isArray(models)) {
      return;
    }

    lastModelCount = models.length;
    lastRunningModelCount = models.filter((model) => model.runtime?.status === "running").length;

    const hasDanger = models.some((model) => ["crashed", "error"].includes(model.runtime?.status));
    const hasWarning = models.some((model) => ["unhealthy", "starting", "warming", "stopping"].includes(model.runtime?.status));

    updateTray(hasDanger ? "danger" : hasWarning ? "warning" : "normal");
  } catch {
    updateTray("danger");
  }
}

async function bootstrap() {
  Menu.setApplicationMenu(null);
  createTray();
  updateTray("warning");

  const started = await startBackend();
  if (!started) {
    updateTray("danger");
    throw new Error("Backend did not become healthy before timeout.");
  }

  createWindow();
  await refreshTrayState();
  setInterval(refreshTrayState, 5000).unref();
}

app.whenReady().then(() => {
  bootstrap().catch((error) => {
    updateTray("danger");
    shell.openPath(path.join(logsDir(), "quokka-backend.log"));
    console.error(error);
  });
});

app.on("before-quit", () => {
  quitting = true;
});

app.on("will-quit", () => {
  stopBackend();
});

app.on("activate", () => {
  showWindow();
});
