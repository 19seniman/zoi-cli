# CLI untuk zoi.network

Script Node.js tanpa dependency untuk login **email + password** ke akun Zoi, dengan kredensial disimpan di `.env`.

Butuh Node.js 18+ · tidak perlu `npm install`.

# 1) Install script

```bash
git clone https://github.com/19seniman/zoi-cli.git
cd zoi-cli
```

# 2) Jalankan sekali

```bash
node zoi.js
```

Perintah ini membuat `.env` berisi template.

# 3) Isi email & password

```bash
nano .env
```

Atau tanpa editor:

```bash
node zoi.js setup --email emailkamu@mail.com --password 'passwordkamu'
```

# 4) Login

```bash
node zoi.js login
```

Kalau akun memakai OTP, script menanyakan kodenya.

# 5) Cek akun

```bash
node zoi.js me
node zoi.js balance
node zoi.js tx
```

## Sync harian & streak

```bash
node zoi.js state     # sudah bisa sync atau belum + kondisi streak
node zoi.js sync      # sync sekarang
node zoi.js auto      # sync otomatis mengikuti jadwal server
```

Streak ikut naik dari sync yang konsisten, jadi cukup jalankan `auto` dan biarkan.

Jalan terus di Termux:

```bash
termux-wake-lock
nohup node zoi.js auto >> zoi-auto.log 2>&1 &
tail -f zoi-auto.log
```

Stop: `pkill -f "zoi.js auto"`.

## Perintah lain

| Perintah | Fungsi |
|---|---|
| `setup` | isi `.env` tanpa editor (kredensial diuji dulu) |
| `edit` | buka `.env` di nano/Notepad |
| `env` | lihat isi `.env` (disamarkan) |
| `logout` | hapus token dari `.env` |
| `state` / `streak` | status sync + streak (read-only) |
| `sync` | sync sekarang (`--force` untuk abaikan jadwal, `--dry-run` untuk uji) |
| `auto` | sync otomatis sesuai `nextSyncAt` (`--once`, `--dry-run`) |
| `ref` | statistik referral |
| `get <path>` / `post <path> '<json>'` | panggil endpoint apa pun |

## Windows (PowerShell)

```powershell
winget install OpenJS.NodeJS.LTS
cd $HOME
git clone https://github.com/19seniman/zoi-cli.git
cd zoi-cli
node zoi.js
node zoi.js setup --email emailkamu@mail.com --password 'passwordkamu'
node zoi.js me
```

`node zoi.js edit` otomatis membuka Notepad.

## Catatan

- Kredensial baru disimpan **setelah** server menerimanya, jadi password salah tidak menimpa `.env`.
- `.env` dibuat dengan permission `600` dan masuk `.gitignore`.
- Detail endpoint ada di [NOTES.md](NOTES.md).
