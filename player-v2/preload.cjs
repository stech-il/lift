const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pirsumEnv", {
  getPaths: () => ipcRenderer.invoke("get-paths"),
  openUserDataFolder: () => ipcRenderer.invoke("open-user-data-folder"),
  quitApp: () => ipcRenderer.invoke("quit-app"),
});
