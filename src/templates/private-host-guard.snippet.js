// Never spoof/fake-audio on a page whose own hostname is your own
// local/private-network infrastructure, not a tracker. Covers RFC 1918
// (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16), loopback (127.0.0.0/8, ::1,
// localhost/*.localhost), and mDNS *.local hostnames. Also avoids breaking
// canvas-readback consoles (e.g. a browser-based VM/VNC viewer) that read
// back what they just drew, which this extension would otherwise serve fake
// pixels for.
if (/^(?:10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2}|127(?:\.\d{1,3}){3}|::1|localhost|.*\.local|.*\.localhost)$/i.test(window.location.hostname)) return;
