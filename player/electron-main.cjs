const { app, BrowserWindow, ipcMain, Menu, shell } = require("electron");
const path = require("path");

let mainWindow;

function createWindow() {
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    fullscreen: true,
    frame: false,
    kiosk: true,
    autoHideMenuBar: true,
    backgroundColor: "#0a0e14",
    show: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle("get-paths", () => ({
  userData: app.getPath("userData"),
}));

/** פותח את תיקיית userData בחלון הקבצים (Explorer / Finder) */
ipcMain.handle("open-user-data-folder", async () => {
  const dir = app.getPath("userData");
  const err = await shell.openPath(dir);
  return { path: dir, error: err || null };
});

ipcMain.handle("quit-app", () => {
  app.quit();
});
