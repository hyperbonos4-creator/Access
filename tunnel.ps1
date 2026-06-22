$ErrorActionPreference = "Continue"

# ==============================
# CONFIGURACION
# ==============================
# Tunel inverso: lleva el RTSP de la camara de casa hasta el servidor Oracle.
#   Camara (192.168.1.34:554)  ->  Oracle 127.0.0.1:18554  ->  go2rtc -> nginx HTTPS
#
# Ver la camara desde el celular:
#   https://157-137-230-190.sslip.io/cam/   (usuario: hide)

$Server     = "ubuntu@157.137.230.190"
$KeyPath    = "C:\Users\Hide\Documents\ssh-key-2026-06-11.key"

$CameraHost = "192.168.1.34"   # IP de la camara en la red de casa
$CameraPort = 554              # puerto RTSP de la camara
$RemotePort = 18554           # puerto en Oracle al que llega la camara

# ==============================
# VALIDACION DE LLAVE
# ==============================
if (!(Test-Path $KeyPath)) {
    Write-Host "[ERROR] No se encontro la llave SSH:" -ForegroundColor Red
    Write-Host $KeyPath -ForegroundColor Yellow
    exit 1
}

# ==============================
# HEADER
# ==============================
Write-Host ""
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "     CAMARA CASA - TUNEL" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Camara local  : $CameraHost`:$CameraPort"
Write-Host "Servidor      : $Server"
Write-Host "Puerto remoto : $RemotePort"
Write-Host ""
Write-Host "Ver en el celular: https://157-137-230-190.sslip.io/cam/"
Write-Host "Manten esta ventana abierta. Ctrl+C para detener."
Write-Host ""

# ==============================
# LOOP DE RECONEXION
# ==============================
while ($true) {

    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$ts] Conectando tunel SSH..." -ForegroundColor Cyan

    ssh -i $KeyPath -N `
        -o ServerAliveInterval=30 `
        -o ServerAliveCountMax=3 `
        -o ExitOnForwardFailure=yes `
        -o StrictHostKeyChecking=accept-new `
        -R "127.0.0.1:${RemotePort}:${CameraHost}:${CameraPort}" `
        $Server

    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host ""
    Write-Host "[$ts] Tunel caido. Reintentando en 5s..." -ForegroundColor Yellow
    Start-Sleep -Seconds 5
}
