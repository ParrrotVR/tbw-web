@echo off
rem Runs the Harbor relay on this PC and publishes it with Tailscale Funnel.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0host\start-harbor-server.ps1"
