' Lanza el tunel de la camara sin mostrar ventana
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -File ""C:\Users\Hide\Desktop\access\tunnel.ps1""", 0, False
