# LiveChat Server

## Folder Structure
```
livechat-deploy/
├── server.js          ← Main backend
├── package.json
├── railway.toml
├── .gitignore
└── public/
    ├── admin.html     ← Served at /admin
    └── widget.js      ← Served at /widget.js
```

## Deploy on Railway
1. Yeh poora folder GitHub repo mein push karo
2. Railway pe connect karo
3. Environment variable set karo: ADMIN_PASSWORD=yourpassword
4. Done!

## URLs after deploy
- Health check: https://your-app.railway.app/
- Admin panel:  https://your-app.railway.app/admin
- Widget JS:    https://your-app.railway.app/widget.js

## Website pe widget lagana
</body> se pehle paste karo:

<script>
  window.LiveChatConfig = {
    server: 'https://your-app.railway.app',
    name: 'Support',
    color: '#6c63ff'
  };
</script>
<script src="https://your-app.railway.app/widget.js"></script>
