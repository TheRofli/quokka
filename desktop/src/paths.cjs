"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

function exists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function projectRoot() {
  if (app.isPackaged) {
    return process.resourcesPath;
  }
  return path.resolve(__dirname, "..", "..");
}

function backendDir() {
  return app.isPackaged ? path.join(process.resourcesPath, "backend") : path.join(projectRoot(), "backend");
}

function frontendDistDir() {
  return app.isPackaged ? path.join(process.resourcesPath, "frontend", "dist") : path.join(projectRoot(), "frontend", "dist");
}

function configPath() {
  return path.join(backendDir(), "config", "quokka.yaml");
}

function logsDir() {
  const dir = app.isPackaged ? path.join(app.getPath("userData"), "logs") : path.join(backendDir(), "logs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function iconPath() {
  const packagedIco = path.join(process.resourcesPath, "icon.ico");
  const packagedIcon = path.join(process.resourcesPath, "icon.png");
  const devIco = path.join(projectRoot(), "desktop", "resources", "icon.ico");
  const devIcon = path.join(projectRoot(), "desktop", "resources", "icon.png");
  const rootIco = path.join(projectRoot(), "icon.ico");
  const rootIcon = path.join(projectRoot(), "ICON.png");

  if (app.isPackaged && exists(packagedIco)) {
    return packagedIco;
  }
  if (app.isPackaged && exists(packagedIcon)) {
    return packagedIcon;
  }
  if (exists(devIco)) {
    return devIco;
  }
  if (exists(devIcon)) {
    return devIcon;
  }
  if (exists(rootIco)) {
    return rootIco;
  }
  if (exists(rootIcon)) {
    return rootIcon;
  }
  return null;
}

function backendExecutable() {
  const exeName = process.platform === "win32" ? "quokka-backend.exe" : "quokka-backend";
  const packagedExe = path.join(backendDir(), exeName);
  return exists(packagedExe) ? packagedExe : null;
}

function pythonExecutable() {
  const candidates = [
    path.join(backendDir(), ".venv", "Scripts", "python.exe"),
    path.join(backendDir(), ".venv", "bin", "python"),
    process.env.QUOKKA_PYTHON,
    process.platform === "win32" ? "python.exe" : "python3",
  ].filter(Boolean);

  return candidates.find((candidate) => candidate === "python.exe" || candidate === "python3" || exists(candidate)) ?? null;
}

module.exports = {
  backendDir,
  backendExecutable,
  configPath,
  frontendDistDir,
  iconPath,
  logsDir,
  projectRoot,
  pythonExecutable,
};
