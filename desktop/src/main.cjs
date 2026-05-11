"use strict";

const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, shell } = require("electron");
const childProcess = require("node:child_process");
const fs = require("node:fs");
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
const METRICS_URL = `http://${HOST}:${PORT}/api/system/metrics`;

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

function logDesktop(message) {
  try {
    const line = `${new Date().toISOString()} | ${message}\n`;
    fs.appendFileSync(path.join(logsDir(), "quokka-desktop.log"), line, "utf8");
  } catch {
    // Logging must never block app startup.
  }
}

function registerIpcHandlers() {
  ipcMain.handle("quokka:open-file", async (_event, options = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title || "Choose a file",
      properties: ["openFile"],
      filters: options.filters || [{ name: "All files", extensions: ["*"] }],
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });

  ipcMain.handle("quokka:open-folder", async (_event, options = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title || "Choose a folder",
      properties: ["openDirectory"],
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });

  ipcMain.handle("quokka:open-external", async (_event, url) => {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      return false;
    }
    await shell.openExternal(url);
    return true;
  });

  ipcMain.handle("quokka:run-update", async () => {
    const updater = path.join(app.getPath("localappdata"), "Quokka", "bin", "quokka-update.cmd");
    if (!fs.existsSync(updater)) {
      return { ok: false, message: "quokka-update.cmd was not found. Re-run the GitHub installer once." };
    }
    childProcess.spawn("cmd.exe", ["/c", "start", "", updater, "-Launch"], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    }).unref();
    return { ok: true, message: "Updater launched. Quokka will restart when the update finishes." };
  });
}

async function backendSupportsCurrentApi() {
  try {
    const metrics = await requestJson(METRICS_URL);
    return Array.isArray(metrics.history) && typeof metrics.disk_read_mb_s !== "undefined";
  } catch {
    return false;
  }
}

function stopProcessOnPort(port) {
  if (process.platform !== "win32") {
    return false;
  }

  try {
    const result = childProcess.spawnSync("netstat", ["-ano", "-p", "tcp"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const rows = `${result.stdout}\n${result.stderr}`.split(/\r?\n/);
    const pattern = new RegExp(`(?:127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::\\]|::1):${port}\\s+.*LISTENING\\s+(\\d+)`, "i");
    const pids = new Set();

    for (const row of rows) {
      const match = row.match(pattern);
      if (match?.[1]) {
        pids.add(match[1]);
      }
    }

    for (const pid of pids) {
      if (pid === String(process.pid)) {
        continue;
      }
      logDesktop(`Stopping process ${pid} on port ${port}`);
      childProcess.spawnSync("taskkill", ["/PID", pid, "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    }

    return pids.size > 0;
  } catch (error) {
    logDesktop(`Failed to stop process on port ${port}: ${error.message}`);
    return false;
  }
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
  const dataDir = path.join(app.getPath("userData"), "data");
  fs.mkdirSync(dataDir, { recursive: true });
  return {
    ...process.env,
    QUOKKA_PROJECT_ROOT: projectRoot(),
    QUOKKA_CONFIG_PATH: configPath(),
    QUOKKA_DATA_DIR: dataDir,
    QUOKKA_LOGS_DIR: logsDir(),
    QUOKKA_FRONTEND_DIST: frontendDistDir(),
    QUOKKA_BACKEND_HOST: HOST,
    QUOKKA_BACKEND_PORT: String(PORT),
    PYTHONUNBUFFERED: "1",
  };
}

async function startBackend() {
  if (await isBackendOnline()) {
    if (await backendSupportsCurrentApi()) {
      ownsBackend = false;
      return true;
    }

    logDesktop("Existing backend API is stale. Restarting backend on port 8000.");
    stopProcessOnPort(PORT);
    await new Promise((resolve) => setTimeout(resolve, 900));

    if (await isBackendOnline()) {
      ownsBackend = false;
      return true;
    }
  }

  const executable = backendExecutable();
  const env = backendEnvironment();

  if (executable) {
    logDesktop(`Starting backend executable: ${executable}`);
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

    logDesktop(`Starting backend through Python: ${python}`);
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
    logDesktop("Backend process exited.");
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
    await mainWindow.loadURL(appUrl());
  }
  await refreshTrayState();
}

function appUrl() {
  return `${APP_URL}?fresh=${Date.now()}`;
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
      preload: path.join(__dirname, "preload.cjs"),
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

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    logDesktop(`Renderer process gone: ${details.reason}`);
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
    logDesktop(`Failed to load ${validatedUrl}: ${errorCode} ${errorDescription}`);
  });

  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level >= 2) {
      logDesktop(`Renderer console ${level} at ${sourceId}:${line}: ${message}`);
    }
  });

  mainWindow.webContents.on("did-finish-load", () => {
    logDesktop("Renderer finished loading.");
  });

  mainWindow.loadURL(appUrl());
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
  logDesktop("Electron app is ready.");
  registerIpcHandlers();
  bootstrap().catch((error) => {
    updateTray("danger");
    logDesktop(`Bootstrap failed: ${error.message}`);
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
