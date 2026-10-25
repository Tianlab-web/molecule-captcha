"""Persistent exact-evidence replay index (shared by restarts, not report scans)."""
import sqlite3
from pathlib import Path
import json
from security_validation import behavior_fingerprint


class ReplayIndex:
    def __init__(self, report_dir):
        self.directory = Path(report_dir)
        self.path = self.directory / 'behavior-index.sqlite3'
        self.ready = False

    def _connect(self):
        self.directory.mkdir(parents=True, exist_ok=True)
        con = sqlite3.connect(self.path, timeout=10)
        con.execute('CREATE TABLE IF NOT EXISTS behavior (fingerprint TEXT PRIMARY KEY, session_id TEXT NOT NULL)')
        if not self.ready:
            # Import the old reports once per database, without changing them.
            con.execute('CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY)')
            if not con.execute("SELECT 1 FROM metadata WHERE name='legacy-import-v1'").fetchone():
                for path in self.directory.glob('*.json'):
                    try:
                        report = json.loads(path.read_text(encoding='utf-8-sig'))
                        if not report.get('structureChanges'):
                            continue
                        fingerprint = behavior_fingerprint(report)
                    except (ValueError, TypeError, AttributeError, OSError):
                        continue
                    con.execute('INSERT OR IGNORE INTO behavior VALUES (?,?)', (fingerprint, path.stem))
                con.execute("INSERT OR IGNORE INTO metadata VALUES ('legacy-import-v1')")
            con.commit()
            self.ready = True
        return con

    def claim(self, fingerprint, session_id):
        con = self._connect()
        try:
            with con:
                cursor = con.execute('INSERT OR IGNORE INTO behavior VALUES (?,?)', (fingerprint, session_id))
                return cursor.rowcount == 1
        finally:
            con.close()
