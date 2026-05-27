const { app, BrowserWindow, shell } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const net = require('net')
const http = require('http')
const ffmpegPath = require('ffmpeg-static')
const ffprobePath = require('ffprobe-static').path

let mainWindow = null
let pythonProcess = null

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

function waitForServer(port, attemptsLeft = 40) {
  return new Promise((resolve, reject) => {
    const try_ = () => {
      http.get(`http://127.0.0.1:${port}/health`, res => {
        if (res.statusCode === 200) return resolve()
        if (--attemptsLeft > 0) return setTimeout(try_, 500)
        reject(new Error('Server did not respond'))
      }).on('error', () => {
        if (--attemptsLeft > 0) setTimeout(try_, 500)
        else reject(new Error('Server failed to start'))
      })
    }
    try_()
  })
}

async function startServer() {
  const port = await findFreePort()

  // Packaged: compiled server binary in resources/
  // Development: dist/server built by PyInstaller
  const serverBin = app.isPackaged
    ? path.join(process.resourcesPath, 'server')
    : path.join(__dirname, 'dist', 'server')

  const resolvedFfmpeg  = app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'ffmpeg')
    : ffmpegPath
  const resolvedFfprobe = app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'ffprobe')
    : ffprobePath

  pythonProcess = spawn(serverBin, [], {
    env: {
      ...process.env,
      PORT: String(port),
      FFMPEG_PATH:  resolvedFfmpeg,
      FFPROBE_PATH: resolvedFfprobe,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  pythonProcess.stdout.on('data', d => console.log('[server]', d.toString().trim()))
  pythonProcess.stderr.on('data', d => console.error('[server]', d.toString().trim()))
  pythonProcess.on('error', err => console.error('Server spawn error:', err.message))

  await waitForServer(port)
  return port
}

async function createWindow() {
  const port = await startServer()

  mainWindow = new BrowserWindow({
    width: 860,
    height: 900,
    minWidth: 560,
    minHeight: 600,
    title: 'Video Compressor',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  mainWindow.loadURL(`http://127.0.0.1:${port}`)

  // Open http(s) links in the system browser, not a new Electron window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => { mainWindow = null })
}

function killServer() {
  if (pythonProcess) {
    pythonProcess.kill()
    pythonProcess = null
  }
}

function pingLaunch() {
  const https = require('https')
  https.get('https://api.counterapi.dev/v1/video-compressor-app/launches/up', () => {})
       .on('error', () => {})
}

app.whenReady().then(() => {
  pingLaunch()
  createWindow()
})

app.on('window-all-closed', () => {
  killServer()
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (!mainWindow) createWindow()
})

app.on('before-quit', killServer)
