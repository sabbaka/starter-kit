useradd rhuser
echo rhuser:1 | chpasswd
echo /usr/bin/tlog-rec-session | chsh rhuser
expect /root/ssh-login.sh 1 ssh rhuser@localhost -oStrictHostKeyChecking=no "echo test; exit"
