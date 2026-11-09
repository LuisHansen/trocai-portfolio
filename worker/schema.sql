CREATE TABLE IF NOT EXISTS visitors (vid TEXT PRIMARY KEY, code TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, ip TEXT, city TEXT, region TEXT, country TEXT, asn TEXT, ua TEXT, device TEXT, sessions INTEGER DEFAULT 1, engaged_ms INTEGER DEFAULT 0, max_scroll INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, vid TEXT NOT NULL, sid TEXT NOT NULL, code TEXT, name TEXT NOT NULL, section TEXT, value INTEGER, meta TEXT, ip TEXT, city TEXT, country TEXT, ua TEXT, url TEXT, referrer TEXT);
CREATE INDEX IF NOT EXISTS idx_events_vid ON events(vid, ts);
CREATE INDEX IF NOT EXISTS idx_events_name ON events(name, ts);
CREATE TABLE IF NOT EXISTS waitlist (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, vid TEXT, code TEXT, name TEXT, email TEXT UNIQUE, picture TEXT, google_sub TEXT, via TEXT, neighborhood TEXT, items TEXT, ip TEXT, city TEXT);
