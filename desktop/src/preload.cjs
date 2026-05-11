"use strict";

const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("quokkaDesktop", {
  app: "Quokka",
});
