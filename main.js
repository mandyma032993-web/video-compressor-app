const { app, BrowserWindow, shell } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const net = require('net')
const http = require('http')

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
  const script = app.isPackaged
    ? path.join(process.resourcesPath, 'server.py')
    : path.join(__dirname, 'server.py')

  pythonProcess = spawn('python3', [script], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  pythonProcess.stdout.on('data', d => console.log('[py]', d.toString().trim()))
  pythonProcess.stderr.on('data', d => console.error('[py]', d.toString().trim()))
  pythonProcess.on('error', err => console.error('Python spawn error:', err.message))

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

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  killServer()
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (!mainWindow) createWindow()
})

app.on('before-quit', killServer)
