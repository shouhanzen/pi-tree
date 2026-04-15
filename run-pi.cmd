@echo off
cd /d C:\Users\Hanzen Shou\workspace\subagent-lab
set EXT=C:\Users\Hanzen Shou\workspace\.pi\extensions\subagent\index.ts
pi -e "%EXT%" %*
