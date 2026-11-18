# Catatan teknis

Endpoint diambil dari bundle aplikasi Android resmi (`assets/index.android.bundle`, Hermes 10,8 MB), bukan tebakan.

```
base URL : https://api.zoi.network/v1
```

## Auth

| Method | Path | Body / catatan |
|---|---|---|
| POST | `/auth/sign-in` | `{email, password, deviceId}` — tanpa `deviceId` server balas `missing_fields` |
| POST | `/auth/sign-in/verify-otp` | kode OTP, kalau akun memakai OTP |
| POST | `/auth/sign-up/send-otp` | `{email}` → `invalid_email` kalau format salah |
| GET | `/auth/me` | butuh `Authorization: Bearer <token>` |
| POST | `/auth/v2/sign-out` | |

Error yang sudah terverifikasi:

```
{"error":"invalid_credentials"}   → email/password salah (HTTP 401)
{"error":"missing_fields"}        → ada field wajib yang belum dikirim
{"error":{"code":"invalid_session","message":"Invalid bearer token"}}
```

## Sync & streak

| Method | Path | Catatan |
|---|---|---|
| GET | `/sync/state` | status: `canSync`, `nextSyncAt`, `lastSyncAt`, `cooldownHours`, `streak*` |
| POST | `/sync` | body mengikuti `syncDeviceInfoRequestSchema`: `deviceId`, `platform`, `timeZone`, `utcOffsetMinutes` |

Bentuk respons `/sync/state` yang teramati (18 Nov 2026):

```json
{"now":"…","balance":11,"humanVerificationRequired":false,
 "sync":{"canSync":false,"nextSyncAt":"…","lastSyncAt":"…","cooldownHours":24,
          "streak":{"tier":1,"days":6}},
 "referral":{…}}
```

Semua field sync **bersarang di `sync`**, bukan di level atas.

Bentuk respons `/sync`:

```json
{"breakdown":{"base":11,"streakMultiplier":1.1,"referralBonus":0,
               "networkBonus":0,"networkShare":0,"invitationBonus":0,"total":11},
 "streak":{"tier":1,"days":6}}
```

Alur login yang terverifikasi: `sign-in` → `{challenge:"email_otp", challengeId}` → `verify-otp` dengan `{challengeId, challenge, otp, deviceId}` → `{sessionToken, authVersion}` → `POST /auth/exchange {sessionToken, deviceId}`. Percobaan kedua dari device yang sama langsung memberi token tanpa OTP.

Streak **tidak** punya endpoint sendiri — datanya ada di `sync.streakInfo.*` pada respons `/sync` dan `/sync/state`. Field tier/streak dibaca fleksibel (`tier`, `tierKey`, `days`, `count`, `daysToNextTier`); kalau bentuk aslinya beda, `node zoi.js state --debug` akan menampilkan JSON mentahnya.

## Endpoint lain yang ada (401 = butuh token)

```
GET  /wallet/balance
GET  /wallet/summary
GET  /transactions
GET  /referrals/stats
POST /referrals/apply
GET  /notifications/unread-count
POST /sync
GET  /feature-flags            (publik)
GET  /app-config/app-version   (publik)
```

## Yang belum terverifikasi

- Bentuk respons sukses `/auth/sign-in` (token di `accessToken`, `tokens.accessToken`, atau `session.*`). Script mencari di semua bentuk itu; kalau tetap gagal, jalankan `node zoi.js login --debug` untuk melihat respons aslinya.
- Nama field OTP (script mencoba `code`, `otp`, lalu dengan `challengeId`).
- Endpoint harian seperti chest/spin/claim: path-nya ada di bundle (`/chests/`, `/claim`, `/tasks/`) tapi belum ketemu bentuk API-nya, jadi belum dipakai script.

## Guard

Jeda 3 detik ±25% antar request tulis, retry 3× backoff eksponensial, `Retry-After` dihormati, timeout 20 detik. Semua bisa diatur lewat `.env` (`ZOI_MIN_GAP_MS`, `ZOI_MAX_RETRIES`, `ZOI_BACKOFF_MS`, `ZOI_TIMEOUT_MS`).
