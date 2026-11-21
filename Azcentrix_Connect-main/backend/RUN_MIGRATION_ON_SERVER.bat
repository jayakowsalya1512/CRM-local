@echo off
echo ============================================
echo  Running: Add no_of_consignee to tenders
echo ============================================
cd /d D:\saas-crm\backend
venv\Scripts\python.exe migrate_no_of_consignee.py
echo.
echo Press any key to close...
pause > nul
