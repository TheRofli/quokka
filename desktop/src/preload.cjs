"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("quokkaDesktop", {
  openFolder: () => ipcRenderer.invoke("quokka:open-folder"),
  openWorkspace: (folderPath, target) => ipcRenderer.invoke("quokka:open-workspace", folderPath, target),
  openTerminal: (folderPath) => ipcRenderer.invoke("quokka:open-terminal", folderPath),
});
