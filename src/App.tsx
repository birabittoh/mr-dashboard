import { useState, useCallback, useRef, useEffect } from "react";

// ── Types ────────────────────────────────────────────────────────────────────

interface Coords {
  x: number;
  y: number;
  z: number;
}

interface LogEvent {
  timestamp: string;
  ip: string;
  uuid: string;
  action: string;
  status?: string;
  name?: string;
  itemType?: string;
  variant?: number;
  coords?: Coords;
  emojiIndex?: number;
  emoji?: string;
  [key: string]: unknown;
}

interface Session {
  uuid: string;
  user: string;
  ip: string;
  loginTime: string;
  logoutTime: string | null;
  status: string;
  durationSec: number | null;
  actions: LogEvent[];
}

type IpNames = Record<string, string>;

const TARGET_TIMEZONE =
  Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Rome";

// ── Parser ───────────────────────────────────────────────────────────────────

function parseLog(raw: string): Session[] {
  const lines = raw.split("\n");
  const joined: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("{")) {
      joined.push(trimmed);
    } else if (joined.length) {
      joined[joined.length - 1] += trimmed;
    }
  }

  const events: LogEvent[] = [];
  for (const line of joined) {
    try {
      events.push(JSON.parse(line) as LogEvent);
    } catch {
      // skip malformed lines
    }
  }

  const openSessions: Record<string, Session[]> = {};
  const floatingActions: LogEvent[] = [];

  for (const ev of events) {
    if (!ev.uuid) continue;
    if (ev.action === "login") {
      if (!openSessions[ev.uuid]) openSessions[ev.uuid] = [];
      openSessions[ev.uuid].push({
        uuid: ev.uuid,
        user: ev.name ?? ev.uuid.slice(0, 8),
        ip: ev.ip,
        loginTime: ev.timestamp,
        logoutTime: null,
        status: ev.status ?? "new",
        durationSec: null,
        actions: [],
      });
    } else if (ev.action === "logout") {
      const stack = openSessions[ev.uuid];
      if (stack?.length) {
        const sess = [...stack].reverse().find((s) => !s.logoutTime);
        if (sess) {
          sess.logoutTime = ev.timestamp;
          sess.durationSec = Math.round(
            (ensureUtc(ev.timestamp).getTime() -
              ensureUtc(sess.loginTime).getTime()) /
              1000
          );
        }
      }
    } else {
      floatingActions.push(ev);
    }
  }

  const flat: Session[] = Object.values(openSessions).flat();
  for (const act of floatingActions) {
    const t = ensureUtc(act.timestamp).getTime();
    const target = flat.find((s) => {
      if (s.uuid !== act.uuid) return false;
      const lo = ensureUtc(s.loginTime).getTime();
      const hi = s.logoutTime ? ensureUtc(s.logoutTime).getTime() : Infinity;
      return t >= lo && t <= hi;
    });
    if (target) target.actions.push(act);
  }

  flat.sort(
    (a, b) =>
      ensureUtc(a.loginTime).getTime() - ensureUtc(b.loginTime).getTime()
  );
  return flat;
}

// ── Formatters ───────────────────────────────────────────────────────────────

function fmtDuration(sec: number | null): string {
  if (sec === null) return "—";
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function ensureUtc(ts: string): Date {
  // If it doesn't look like it has a timezone offset, assume UTC
  if (!ts.includes("Z") && !/[+-]\d{2}:?\d{2}$/.test(ts)) {
    return new Date(ts + "Z");
  }
  return new Date(ts);
}

function fmtTime(ts: string): string {
  return ensureUtc(ts).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: TARGET_TIMEZONE,
  });
}

function fmtDate(ts: string): string {
  return ensureUtc(ts).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: TARGET_TIMEZONE,
  });
}

function parseLogTimestamp(filename: string): string | null {
  // 20260328-090714-my-service.log
  const match = filename.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
  if (!match) return null;
  const [, y, m, d, hh, mm, ss] = match;
  // Filenames are UTC per requirement
  const date = new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}Z`);
  if (isNaN(date.getTime())) return null;
  return date.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: TARGET_TIMEZONE,
  });
}

function parseLogName(filename: string): string {
  // 20260328-090714-my-service.log -> my-service
  const cleaned = filename.replace(/\.log$|\.txt$/i, "");
  const parts = cleaned.split("-");
  // if it matches our timestamp format, the first two parts are date and time
  if (parts.length >= 3 && /^\d{8}$/.test(parts[0]) && /^\d{6}$/.test(parts[1])) {
    return parts.slice(2).join("-");
  }
  return cleaned;
}

function fmtActionDesc(ev: LogEvent): string {
  if (ev.action === "place_furniture") {
    const item = ((ev.itemType as string) ?? "").replace(/_/g, " ");
    const v = ev.variant != null ? ` v${ev.variant}` : "";
    const c = ev.coords
      ? ` @ (${ev.coords.x}, ${ev.coords.y}, ${ev.coords.z})`
      : "";
    return `Place ${item}${v}${c}`;
  }
  if (ev.action === "unlock_emoji") {
    return `Unlock emoji #${ev.emojiIndex}${ev.emoji ? " " + ev.emoji : ""}`;
  }
  return ev.action.replace(/_/g, " ");
}

const ACTION_DOT: Record<string, string> = {
  place_furniture: "bg-sky-400",
  unlock_emoji: "bg-emerald-400",
  default: "bg-zinc-400",
};

const ACTION_ICON: Record<string, string> = {
  place_furniture: "🛋️",
  unlock_emoji: "✨",
  login: "🚀",
  logout: "💤",
  default: "🔹",
};

// ── IpLabel — clickable IP that opens an inline rename field ─────────────────

function IpLabel({
  ip,
  ipNames,
  onRename,
  className = "",
}: {
  ip: string;
  ipNames: IpNames;
  onRename: (ip: string, name: string) => void;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const displayName = ipNames[ip];

  function startEdit(e: React.MouseEvent) {
    e.stopPropagation();
    setDraft(displayName ?? ip);
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }

  function commit() {
    const trimmed = draft.trim();
    onRename(ip, trimmed || ip);
    setEditing(false);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") setEditing(false);
  }

  async function handleGeoLookup(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      const resp = await fetch(`https://ipapi.co/${ip}/json/`);
      if (!resp.ok) throw new Error("Fetch failed");
      const data = await resp.json();
      if (data.city && data.country_name) {
        setDraft(`${data.city}, ${data.country_name}`);
      } else {
        throw new Error("Incomplete data");
      }
    } catch (err) {
      window.open(`https://ipapi.co/${ip}/`, "_blank");
    }
  }

  if (editing) {
    return (
      <span
        className={`inline-flex items-center gap-1 ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative flex items-center">
          <input
            ref={inputRef}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={onKey}
            className="font-mono text-xs bg-zinc-800 border border-zinc-600 rounded px-1.5 py-0.5 pr-7 text-zinc-200 outline-none focus:border-sky-500 w-44"
          />
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleGeoLookup}
            title="Lookup geolocation"
            className="absolute right-1 p-1 text-zinc-500 hover:text-sky-400 transition-colors"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
          </button>
        </div>
      </span>
    );
  }

  return (
    <span
      onClick={startEdit}
      title={displayName ? `${displayName} (${ip}) — click to rename` : "Click to assign a name"}
      className={`inline-flex items-center gap-1 cursor-pointer group/ip ${className}`}
    >
      <span className="font-mono text-xs text-zinc-500 group-hover/ip:text-zinc-300 transition-colors">
        {displayName ?? ip}
      </span>
      {displayName && (
        <span className="font-mono text-xs text-zinc-700 group-hover/ip:text-zinc-500 transition-colors">
          ({ip})
        </span>
      )}
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-zinc-700 group-hover/ip:text-zinc-400 transition-colors shrink-0"
      >
        <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
        <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
      </svg>
    </span>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function MetricCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-zinc-900 rounded-xl p-4 flex flex-col gap-1 border border-zinc-800">
      <span className="text-xs text-zinc-500 uppercase tracking-widest">{label}</span>
      <span className="text-3xl font-light text-zinc-100 tabular-nums">{value}</span>
    </div>
  );
}

function Badge({ status }: { status: string }) {
  const cls =
    status === "returning"
      ? "bg-emerald-950 text-emerald-400 border border-emerald-800"
      : "bg-sky-950 text-sky-400 border border-sky-800";
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-mono ${cls}`}>
      {status}
    </span>
  );
}

function SessionRow({
  session,
  selected,
  multiSelected,
  onMultiSelect,
  ipNames,
  onRename,
  onClick,
}: {
  session: Session;
  selected: boolean;
  multiSelected: boolean;
  onMultiSelect: (checked: boolean) => void;
  ipNames: IpNames;
  onRename: (ip: string, name: string) => void;
  onClick: () => void;
}) {
  return (
    <tr
      onClick={onClick}
      className={`cursor-pointer transition-colors ${
        selected ? "bg-zinc-700/60" : "hover:bg-zinc-800/50"
      }`}
    >
      <td className="py-2.5 px-3" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={multiSelected}
          onChange={(e) => onMultiSelect(e.target.checked)}
          className="w-4 h-4 rounded border-zinc-700 bg-zinc-800 text-sky-500 focus:ring-sky-500 focus:ring-offset-zinc-900"
        />
      </td>
      <td className="py-2.5 px-3 font-mono text-xs text-zinc-400 whitespace-nowrap">
        {fmtDate(session.loginTime)}
      </td>
      <td className="py-2.5 px-3">
        <span className="text-zinc-200 text-sm">{session.user}</span>
        <span className="text-zinc-600 font-mono text-xs ml-2">
          {session.uuid.slice(0, 8)}
        </span>
      </td>
      <td className="py-2.5 px-3">
        <IpLabel ip={session.ip} ipNames={ipNames} onRename={onRename} />
      </td>
      <td className="py-2.5 px-3">
        <Badge status={session.status} />
      </td>
      <td className="py-2.5 px-3 font-mono text-xs text-zinc-400 text-right">
        {fmtDuration(session.durationSec)}
      </td>
    </tr>
  );
}

function DurationBar({
  sessions,
  selected,
  onSelect,
}: {
  sessions: Session[];
  selected: number | null;
  onSelect: (i: number) => void;
}) {
  const max = Math.max(...sessions.map((s) => s.durationSec ?? 0), 1);
  return (
    <div className="flex flex-col gap-1">
      {sessions.map((s, i) => {
        const pct = Math.max(((s.durationSec ?? 0) / max) * 100, 0.5);
        const isRet = s.status === "returning";
        return (
          <div
            key={s.uuid + s.loginTime}
            className="flex items-center gap-2 cursor-pointer group"
            onClick={() => onSelect(i)}
          >
            <span className="text-zinc-600 font-mono text-xs w-16 shrink-0 text-right truncate">
              {s.user}
            </span>
            <div className="flex-1 h-5 relative flex items-center">
              <div
                className={`h-full rounded transition-all ${
                  selected === i ? "opacity-100" : "opacity-60 group-hover:opacity-80"
                } ${isRet ? "bg-emerald-500" : "bg-sky-500"}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-zinc-600 font-mono text-xs w-12 shrink-0">
              {fmtDuration(s.durationSec)}
            </span>
          </div>
        );
      })}
      <div className="flex gap-4 mt-1 ml-[72px]">
        <span className="flex items-center gap-1.5 text-xs text-zinc-600">
          <span className="w-2.5 h-2.5 rounded-sm bg-sky-500 inline-block" /> new
        </span>
        <span className="flex items-center gap-1.5 text-xs text-zinc-600">
          <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500 inline-block" /> returning
        </span>
      </div>
    </div>
  );
}

function Timeline({
  sessions,
}: {
  sessions: Session[];
}) {
  if (sessions.length === 0) return null;

  const startTimes = sessions.map((s) => ensureUtc(s.loginTime).getTime());
  const endTimes = sessions.map((s) =>
    s.logoutTime ? ensureUtc(s.logoutTime).getTime() : Date.now()
  );

  const minTime = Math.min(...startTimes);
  const maxTime = Math.max(...endTimes);
  const range = maxTime - minTime || 1;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 overflow-hidden">
      <p className="text-xs text-zinc-500 uppercase tracking-widest mb-6">
        Multi-session Timeline
      </p>
      <div className="relative space-y-1.5 pt-8">
        {/* Time markers */}
        <div className="absolute top-0 left-0 w-full flex justify-between px-1 border-b border-zinc-800 pb-1.5">
          <span className="text-[10px] text-zinc-500 font-mono">
            {new Date(minTime).toLocaleTimeString("en-GB", {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
              timeZone: TARGET_TIMEZONE,
            })}
          </span>
          <span className="text-[10px] text-zinc-500 font-mono">
            {new Date(maxTime).toLocaleTimeString("en-GB", {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
              timeZone: TARGET_TIMEZONE,
            })}
          </span>
        </div>

        {sessions.map((s) => {
          const start = ensureUtc(s.loginTime).getTime();
          const end = s.logoutTime
            ? ensureUtc(s.logoutTime).getTime()
            : Date.now();
          const left = ((start - minTime) / range) * 100;
          const width = ((end - start) / range) * 100;

          return (
            <div key={s.uuid + s.loginTime} className="relative h-8 group/row">
              <div
                className={`absolute top-0 h-full rounded-lg transition-all flex items-center px-3 overflow-hidden ${
                  s.status === "returning"
                    ? "bg-emerald-500/10 border border-emerald-500/30"
                    : "bg-sky-500/10 border border-sky-500/30"
                }`}
                style={{ left: `${left}%`, width: `${Math.max(width, 0.5)}%` }}
              >
                <div className="text-[10px] font-mono truncate whitespace-nowrap pointer-events-none flex items-center gap-2 shrink-0">
                  <span className="text-zinc-200 font-medium">{s.user}</span>
                  <span className="text-zinc-500 text-[9px]">
                    {fmtTime(s.loginTime)} –{" "}
                    {s.logoutTime ? fmtTime(s.logoutTime) : "now"}
                  </span>
                </div>
                {/* Action markers */}
                {s.actions.map((a, i) => {
                  const aTime = ensureUtc(a.timestamp).getTime();
                  const aLeft = ((aTime - start) / (end - start || 1)) * 100;
                  const icon = ACTION_ICON[a.action] || ACTION_ICON.default;

                  return (
                    <div
                      key={i}
                      className="absolute group/icon cursor-default"
                      style={{ left: `${aLeft}%`, transform: 'translateX(-50%)' }}
                    >
                      <span className="text-xs filter drop-shadow-sm group-hover/icon:scale-125 transition-transform inline-block">
                        {icon}
                      </span>
                      {/* Tooltip */}
                      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover/icon:block z-50">
                        <div className="bg-zinc-800 text-zinc-100 text-[10px] py-1.5 px-2.5 rounded shadow-xl border border-zinc-700 whitespace-nowrap">
                          <div className="font-bold border-b border-zinc-700 pb-1 mb-1">{fmtTime(a.timestamp)}</div>
                          {fmtActionDesc(a)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DetailPanel({
  session,
  ipNames,
  onRename,
}: {
  session: Session | null;
  ipNames: IpNames;
  onRename: (ip: string, name: string) => void;
}) {
  if (!session) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-zinc-600 text-sm gap-2 py-16">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M9 12h6M9 16h3M5 8h14M3 5a2 2 0 012-2h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5z" />
        </svg>
        <span>Select a session to inspect</span>
      </div>
    );
  }
  return (
    <div>
      <div className="mb-4 pb-3 border-b border-zinc-800">
        <div className="text-zinc-200 font-medium">{session.user}</div>
        <div className="text-zinc-500 font-mono text-xs mt-0.5">
          {fmtDate(session.loginTime)} · {fmtTime(session.loginTime)} —{" "}
          {session.logoutTime ? fmtTime(session.logoutTime) : "active"} ·{" "}
          {fmtDuration(session.durationSec)}
        </div>
        <div className="flex gap-2 mt-2 items-center">
          <Badge status={session.status} />
          <IpLabel ip={session.ip} ipNames={ipNames} onRename={onRename} />
        </div>
      </div>
      {session.actions.length === 0 ? (
        <p className="text-zinc-600 text-sm">No in-session actions.</p>
      ) : (
        <div className="flex flex-col">
          {session.actions.map((a, i) => {
            const dotCls = ACTION_DOT[a.action] ?? ACTION_DOT["default"];
            return (
              <div
                key={i}
                className="flex items-start gap-3 py-2.5 border-b border-zinc-800/60 last:border-0"
              >
                <span className="font-mono text-xs text-zinc-600 shrink-0 mt-0.5 w-16">
                  {fmtTime(a.timestamp)}
                </span>
                <span className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${dotCls}`} />
                <span className="text-sm text-zinc-300">{fmtActionDesc(a)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Drop zone ────────────────────────────────────────────────────────────────

function DropZone({
  onFile,
  compact = false,
}: {
  onFile: (text: string, name: string) => void;
  compact?: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [pastedText, setPastedText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const readFile = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = (e) => onFile(e.target!.result as string, file.name);
      reader.readAsText(file);
    },
    [onFile]
  );

  if (pasting) {
    return (
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-zinc-300">Paste log content</span>
          <button
            onClick={() => setPasting(false)}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Cancel
          </button>
        </div>
        <textarea
          autoFocus
          className="w-full h-64 bg-zinc-950 border border-zinc-800 rounded-xl p-4 text-xs font-mono text-zinc-400 focus:border-sky-500 outline-none resize-none"
          placeholder='{"timestamp": "...", "action": "login", ...}'
          value={pastedText}
          onChange={(e) => setPastedText(e.target.value)}
        />
        <button
          onClick={() => {
            if (pastedText.trim()) {
              onFile(pastedText, "pasted-log.log");
              setPasting(false);
              setPastedText("");
            }
          }}
          disabled={!pastedText.trim()}
          className="w-full bg-sky-600 hover:bg-sky-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium py-2.5 rounded-xl transition-colors"
        >
          Parse log
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]);
        }}
        onClick={() => inputRef.current?.click()}
        className={`border-2 border-dashed rounded-2xl flex flex-col items-center gap-3 cursor-pointer transition-colors ${
          dragging
            ? "border-sky-500 bg-sky-500/5"
            : "border-zinc-700 hover:border-zinc-500"
        } ${compact ? "p-6" : "p-16"}`}
      >
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          className="text-zinc-500"
        >
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="12" y1="18" x2="12" y2="12" />
          <line x1="9" y1="15" x2="15" y2="15" />
        </svg>
        <div className="text-center">
          <p className="text-zinc-300 font-medium text-sm">
            {compact ? "Load a different file" : "Drop your service.log here"}
          </p>
          <p className="text-zinc-600 text-xs mt-1">or click to browse</p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".log,.txt,text/plain"
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.[0]) readFile(e.target.files[0]);
          }}
        />
      </div>
      {!compact && (
        <button
          onClick={() => setPasting(true)}
          className="w-full border border-zinc-800 hover:border-zinc-700 bg-zinc-900/50 text-zinc-400 hover:text-zinc-200 text-xs font-medium py-3 rounded-2xl transition-all"
        >
          or paste log content directly
        </button>
      )}
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [filename, setFilename] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [multiSelected, setMultiSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState("");
  const [ipNames, setIpNames] = useState<IpNames>(() => {
    try {
      const saved = localStorage.getItem("ipNames");
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  useEffect(() => {
    localStorage.setItem("ipNames", JSON.stringify(ipNames));
  }, [ipNames]);
  useEffect(() => {
    const savedContent = localStorage.getItem("lastLogContent");
    const savedFilename = localStorage.getItem("lastLogFilename");
    if (savedContent && savedFilename) {
      try {
        const s = parseLog(savedContent);
        if (s.length) {
          setSessions(s);
          setFilename(savedFilename);
        }
      } catch (err) {
        console.error("Failed to parse saved log:", err);
      }
    }
  }, []);
  const actionsRef = useRef<HTMLDivElement>(null);

  const handleFile = useCallback((text: string, name: string) => {
    setError("");
    try {
      const s = parseLog(text);
      if (!s.length)
        throw new Error("No login/logout pairs found. Check the file format.");
      setSessions(s);
      setFilename(name);
      setSelected(null);
      setMultiSelected(new Set());

      try {
        localStorage.setItem("lastLogContent", text);
        localStorage.setItem("lastLogFilename", name);
      } catch (err) {
        console.warn("Failed to save log to localStorage:", err);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unknown parse error");
    }
  }, []);

  const selectSession = useCallback((i: number | null) => {
    setSelected(i);
    if (i !== null && window.innerWidth < 768) {
      setTimeout(() => {
        actionsRef.current?.scrollIntoView({ behavior: "smooth" });
      }, 0);
    }
  }, []);

  const handleRename = useCallback((ip: string, name: string) => {
    setIpNames((prev) => {
      // if the user cleared back to the raw IP, remove the alias
      if (name === ip) {
        const next = { ...prev };
        delete next[ip];
        return next;
      }
      return { ...prev, [ip]: name };
    });
  }, []);

  const totalActions = sessions.reduce((a, s) => a + s.actions.length, 0);
  const uniqueUsers = new Set(sessions.map((s) => s.uuid)).size;
  const allIPs = Array.from(new Set(sessions.map((s) => s.ip)));
  const uniqueIPs = allIPs.length;
  const unidentifiedIPs = allIPs.filter((ip) => !ipNames[ip]);

  const handleBulkGeoLookup = useCallback(async () => {
    for (const ip of unidentifiedIPs) {
      try {
        const resp = await fetch(`https://ipapi.co/${ip}/json/`);
        if (resp.status === 429) {
          setError("Bulk lookup rate limited. Please try again later.");
          break;
        }
        if (!resp.ok) continue;
        const data = await resp.json();
        if (data.city && data.country_name) {
          handleRename(ip, `${data.city}, ${data.country_name}`);
        }
      } catch (err) {
        // Skip on error for bulk to avoid spamming tabs
      }
      // Increased delay to avoid rate limits
      await new Promise((r) => setTimeout(r, 2000));
    }
  }, [unidentifiedIPs, handleRename]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6 font-sans">
      <div className="max-w-6xl mx-auto space-y-5">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-medium text-zinc-100 tracking-tight">
              {filename ? parseLogName(filename) : "service.log"}
            </h1>
            {filename && parseLogTimestamp(filename) && (
              <div className="flex flex-col md:flex-row md:items-center md:gap-3 mt-0.5">
                <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-medium">
                  Last updated: {parseLogTimestamp(filename)}
                </span>
              </div>
            )}
          </div>
          {sessions.length > 0 && (
            <div className="flex items-center gap-2">
              {unidentifiedIPs.length > 0 && (
                <button
                  onClick={handleBulkGeoLookup}
                  className="text-[10px] uppercase tracking-wider font-bold text-sky-500 border border-sky-500/30 bg-sky-500/5 rounded-lg px-3 py-1.5 hover:bg-sky-500/10 transition-colors"
                >
                  Lookup {unidentifiedIPs.length} IP{unidentifiedIPs.length > 1 ? "s" : ""}
                </button>
              )}
              <label className="cursor-pointer">
                <span className="text-xs text-zinc-400 border border-zinc-700 rounded-lg px-3 py-1.5 hover:border-zinc-500 hover:text-zinc-200 transition-colors">
                  Load file
                </span>
                <input
                  type="file"
                  accept=".log,.txt,text/plain"
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files?.[0]) {
                      const r = new FileReader();
                      r.onload = (ev) =>
                        handleFile(ev.target!.result as string, e.target.files![0].name);
                      r.readAsText(e.target.files[0]);
                    }
                  }}
                />
              </label>
            </div>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="bg-red-950/50 border border-red-800 rounded-xl px-4 py-3 text-red-400 text-sm">
            {error}
          </div>
        )}

        {sessions.length === 0 ? (
          <DropZone onFile={handleFile} />
        ) : (
          <>
            {/* Metrics */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MetricCard label="Sessions" value={sessions.length} />
              <MetricCard label="Unique users" value={uniqueUsers} />
              <MetricCard label="Unique IPs" value={uniqueIPs} />
              <MetricCard label="Actions" value={totalActions} />
            </div>

            {/* Duration chart */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
              <p className="text-xs text-zinc-500 uppercase tracking-widest mb-4">
                Session duration
              </p>
              <DurationBar
                sessions={sessions}
                selected={selected}
                onSelect={(i) => selectSession(i === selected ? null : i)}
              />
            </div>

            {/* Table + detail */}
            <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
              <div className={`${selected !== null ? 'md:col-span-3' : 'md:col-span-5'} bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden`}>
                <div className="px-4 pt-4 pb-2">
                  <p className="text-xs text-zinc-500 uppercase tracking-widest">Sessions</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-zinc-800">
                        <th className="py-2 px-3 w-8">
                          <input
                            type="checkbox"
                            checked={
                              sessions.length > 0 &&
                              multiSelected.size === sessions.length
                            }
                            onChange={(e) => {
                              if (e.target.checked) {
                                setMultiSelected(
                                  new Set(sessions.map((_, i) => i))
                                );
                              } else {
                                setMultiSelected(new Set());
                              }
                            }}
                            className="w-4 h-4 rounded border-zinc-700 bg-zinc-800 text-sky-500 focus:ring-sky-500 focus:ring-offset-zinc-900"
                          />
                        </th>
                        {["Date", "User", "IP", "Status", "Duration"].map((h) => (
                          <th
                            key={h}
                            className="py-2 px-3 text-xs text-zinc-600 font-medium uppercase tracking-wider whitespace-nowrap"
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sessions.map((s, i) => (
                        <SessionRow
                          key={s.uuid + s.loginTime}
                          session={s}
                          selected={selected === i}
                          multiSelected={multiSelected.has(i)}
                          onMultiSelect={(checked) => {
                            setMultiSelected((prev) => {
                              const next = new Set(prev);
                              if (checked) next.add(i);
                              else next.delete(i);
                              return next;
                            });
                          }}
                          ipNames={ipNames}
                          onRename={handleRename}
                          onClick={() => selectSession(i === selected ? null : i)}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {selected !== null && (
                <div
                  ref={actionsRef}
                  className="md:col-span-2 bg-zinc-900 border border-zinc-800 rounded-2xl p-5 min-h-48"
                >
                  <p className="text-xs text-zinc-500 uppercase tracking-widest mb-4">
                    Actions
                  </p>
                  <DetailPanel
                    session={sessions[selected]}
                    ipNames={ipNames}
                    onRename={handleRename}
                  />
                </div>
              )}
            </div>

            {/* Timeline */}
            <Timeline
              sessions={sessions.filter((_, i) => multiSelected.has(i))}
            />
          </>
        )}
      </div>
    </div>
  );
}
