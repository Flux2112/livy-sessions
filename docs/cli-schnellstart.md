# Livy CLI – Schnellstart

## Was ist die Livy CLI?

Die `@livy/cli` ist ein kommandozeilenbasiertes Werkzeug zur Steuerung von Apache Livy Sessions, Statements, Batch-Jobs und HDFS-Uploads. Sie wurde speziell für die **Automatisierung durch Agenten** entwickelt:

- **JSON auf stdout** als Standardausgabe – keine Farben, keine interaktiven Prompts
- **Stateless**: Jeder Befehl erhält alle nötigen IDs explizit als Argumente
- **Deterministischer Exit-Code** pro Fehlerkategorie (0=OK, 2=Config, 3=API, 4=Abbruch, 5=Timeout)
- **NDJSON-Fortschrittsereignisse auf stderr** bei `--verbose`

---

## Installation

```bash
# Aus dem Monorepo-Root:
npm install
npm run build -w @livy/cli

# Prüfen, ob die CLI funktioniert:
node packages/cli/bin/run.js --help
```

---

## Konfiguration

Die CLI löst Einstellungen in dieser Reihenfolge auf (erste Treffer gewinnt):

| Priorität | Quelle | Beispiel |
|-----------|--------|----------|
| 1 | CLI-Flags | `--server-url http://livy:8998` |
| 2 | Umgebungsvariablen | `LIVY_SERVER_URL=http://livy:8998` |
| 3 | Explizite Config-Datei | `--config ./mein-config.json` oder `LIVY_CONFIG=...` |
| 4 | Workspace-Config | `.livyrc.json` im aktuellen Verzeichnis |
| 5 | Home-Config | `~/.livy/config.json` |
| 6 | Standardwerte | `http://localhost:8998`, Auth `none`, Kind `pyspark` |

### Variante A: Config-Datei (empfohlen)

Erstelle eine Datei `.livyrc.json` im Projektverzeichnis oder `~/.livy/config.json` global:

```json
{
  "livy": {
    "serverUrl": "https://livy.mein-cluster.intern:8998",
    "authMethod": "kerberos",
    "kerberosServicePrincipal": "HTTP@livy.mein-cluster.intern",
    "defaultKind": "pyspark",
    "sessionName": "agent-session",
    "driverMemory": "2g",
    "executorMemory": "4g",
    "numExecutors": 2,
    "jars": ["hdfs:///libs/shared.jar"],
    "conf": {
      "spark.dynamicAllocation.enabled": "false"
    }
  },
  "hdfs": {
    "baseUrl": "https://namenode.mein-cluster.intern:9870",
    "uploadPath": "/user/mein-user/livy-deps"
  }
}
```

### Variante B: Umgebungsvariablen

```bash
export LIVY_SERVER_URL=https://livy.mein-cluster.intern:8998
export LIVY_AUTH_METHOD=basic
export LIVY_USERNAME=alice
export LIVY_PASSWORD=geheim
export LIVY_HDFS_BASE_URL=https://namenode:9870
```

Alle unterstützten Variablen:

| Variable | Beschreibung |
|----------|-------------|
| `LIVY_SERVER_URL` | Basis-URL des Livy-Servers |
| `LIVY_AUTH_METHOD` | `none`, `basic`, `bearer` oder `kerberos` |
| `LIVY_USERNAME` | Benutzername (Basic Auth / HDFS) |
| `LIVY_PASSWORD` | Passwort (Basic Auth) |
| `LIVY_BEARER_TOKEN` | Bearer-Token |
| `LIVY_KERBEROS_SERVICE_PRINCIPAL` | Kerberos-SPN, z.B. `HTTP@host` |
| `LIVY_KERBEROS_DELEGATE` | `true` für Credential-Delegation |
| `LIVY_HDFS_BASE_URL` | WebHDFS-URL des NameNode |
| `LIVY_HDFS_UPLOAD_PATH` | HDFS-Zielpfad (Standard: `/user/{username}/livy-deps`) |
| `LIVY_POLL_INTERVAL_MS` | Polling-Intervall für Statements (ms) |
| `LIVY_SESSION_POLL_INTERVAL_MS` | Polling-Intervall für Sessions (ms) |
| `LIVY_CONFIG` | Pfad zu einer JSON-Config-Datei |

### Variante C: Nur CLI-Flags

```bash
node packages/cli/bin/run.js session list \
  --server-url https://livy:8998 \
  --auth-method basic \
  --username alice \
  --password geheim
```

> **Tipp:** Flags und Umgebungsvariablen lassen sich beliebig kombinieren – Flags haben immer Vorrang.

---

## Erste Schritte

### 1. Konfiguration prüfen

```bash
livy config show
```

Zeigt die aufgelöste Konfiguration (Passwörter werden als `[redacted]` angezeigt).

### 2. Sessions auflisten

```bash
livy session list
```

### 3. Session erstellen

```bash
# Synchron warten bis Session "idle" ist:
livy session create --kind pyspark --name meine-session

# Sofort zurückkehren ohne zu warten:
livy session create --kind pyspark --no-wait
```

### 4. Code ausführen

```bash
# Inline-Code:
livy exec run 12 --code "print('Hallo Welt')"

# Aus Datei:
livy exec run 12 --file ./analyse.py

# Von stdin (Pipe):
cat script.py | livy exec run 12
```

### 5. Logs abrufen

```bash
# Letzte Logs abrufen:
livy logs get 12

# Logs live verfolgen:
livy logs tail 12 --follow
```

### 6. HDFS-Upload

```bash
# Einzelne Datei hochladen (gibt die URI als String zurück):
livy hdfs upload ./build/job.jar

# Verzeichnis als ZIP hochladen:
livy hdfs upload-dir ./deps --remote-name deps.zip

# In Kombination – Upload + Session mit Dependency:
URI=$(livy hdfs upload ./lib.jar)
livy session create --jar "$URI"
```

### 7. Session beenden

```bash
livy session kill 12

# Alle eigenen Sessions beenden:
livy session kill-all

# Alle Sessions aller Benutzer beenden:
livy session kill-all --all
```

---

## Batch-Jobs

```bash
# Batch einreichen:
livy batch submit \
  --file hdfs:///apps/main.jar \
  --class-name com.example.Main \
  --arg "--datum=2026-01-01"

# Status abfragen:
livy batch state 7

# Batch-Logs verfolgen:
livy logs batch 7 --follow

# Batch abbrechen:
livy batch kill 7
```

---

## Tipps für die Agent-Nutzung

- **JSON parsen:** Stdout ist immer JSON – verwende `jq` oder den JSON-Parser deines Agenten.
- **Exit-Codes prüfen:** `0` = Erfolg, alles andere = Fehler. Code `3` bedeutet Livy-API-Fehler.
- **`--no-wait` für Fire-and-Forget:** Session oder Batch starten, ID aus JSON lesen, später abfragen.
- **`--verbose` für Echtzeit-Fortschritt:** NDJSON-Events auf stderr zeigen Session-State-Übergänge und Statement-Fortschritt.
- **`--json` für oclif-Serialisierung:** Zusätzlich zum Standard-JSON-Output unterstützt die CLI das oclif-native `--json`-Flag, das die Rückgabewerte der Befehle serialisiert.
- **HDFS-Upload gibt eine reine URI zurück:** Der Output von `hdfs upload` ist ein nackter String – ideal für Shell-Substitution (`$(livy hdfs upload ...)`).
