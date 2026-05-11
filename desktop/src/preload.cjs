"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("quokkaDesktop", {
  app: "Quokka",
  openFile: (options) => ipcRenderer.invoke("quokka:open-file", options),
  openFolder: (options) => ipcRenderer.invoke("quokka:open-folder", options),
  openExternal: (url) => ipcRenderer.invoke("quokka:open-external", url),
  runUpdate: () => ipcRenderer.invoke("quokka:run-update"),
});
