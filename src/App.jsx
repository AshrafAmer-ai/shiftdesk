// ============================================================
// SHIFTDESK PRO — Connected to Supabase
// 
// SETUP (takes ~5 minutes):
// 1. Go to supabase.com → New Project
// 2. Run supabase-schema.sql in Dashboard → SQL Editor
// 3. Go to Dashboard → Settings → API
// 4. Replace the two lines below with your real values:
// ============================================================

const SUPABASE_URL  = "https://xmgforwcyjneofyzfrbb.supabase.co";  // ← paste here
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhtZ2ZvcndjeWpuZW9meXpmcmJiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1NzgzMjAsImV4cCI6MjA5NTE1NDMyMH0.n-YIBUFkUlDQgekZY3wyfnt5diBkbPOA85L5aGEX2I4";                 // ← paste here

// ============================================================
import { useState, useEffect, useRef, useCallback } from "react";

// ── Tiny Supabase client (no npm needed in this artifact) ──
const supa = (() => {
  const headers = {
    "Content-Type": "application/json",
    "apikey": SUPABASE_ANON,
    "Authorization": `Bearer ${SUPABASE_ANON}`,
    "Prefer": "return=representation",
  };
  const base = (table) => `${SUPABASE_URL}/rest/v1/${table}`;
  const rt   = () => `${SUPABASE_URL.replace("https","wss")}/realtime/v1/websocket?apikey=${SUPABASE_ANON}&vsn=1.0.0`;

  return {
    // SELECT with optional query string, e.g. "date=eq.2026-06-01"
    select: async (table, qs = "") => {
      const r = await fetch(`${base(table)}?${qs}&select=*`, { headers });
      return r.json();
    },
    // INSERT single row
    insert: async (table, row) => {
      const r = await fetch(base(table), { method:"POST", headers, body: JSON.stringify(row) });
      return r.json();
    },
    // UPDATE with match filter object, e.g. {id: "abc"}
    update: async (table, match, data) => {
      const qs = Object.entries(match).map(([k,v])`${k}=eq.${v}`).join("&");
      const r = await fetch(`${base(table)}?${qs}`, { method:"PATCH", headers, body: JSON.stringify(data) });
      return r.json();
    },
    // UPSERT (insert or update on conflict)
    upsert: async (table, row, onConflict) => {
      const h = { ...headers, "Prefer": `resolution=merge-duplicates,return=representation` };
      const r = await fetch(`${base(table)}?on_conflict=${onConflict}`, { method:"POST", headers:h, body: JSON.stringify(row) });
      return r.json();
    },
    // DELETE with match filter
    delete: async (table, match) => {
      const qs = Object.entries(match).map(([k,v])`${k}=eq.${v}`).join("&");
      const r = await fetch(`${base(table)}?${qs}`, { method:"DELETE", headers });
      return r.ok;
    },
    // Realtime WebSocket subscription
    subscribe: (table, onMessage) => {
      const ws = new WebSocket(rt());
      ws.onopen = () => {
        ws.send(JSON.stringify({ topic:`realtime:public:${table}`, event:"phx_join", payload:{}, ref:"1" }));
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.event === "INSERT" || msg.event === "UPDATE" || msg.event === "DELETE") {
          onMessage(msg.event, msg.payload?.record, msg.payload?.old_record);
        }
      };
      return () => ws.close();
    },
  };
})();

// ── Constants ──────────────────────────────────────────────
const SHIFTS     = ["Morning (8–13)", "Afternoon (13–18)"];
const DAYS_SHORT = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
const LEAVE_QUOTA = 5;

const fmt   = (d) => d.toISOString().split("T")[0];
const parseD = (s) => new Date(s + "T00:00:00");
const getDaysInMonth = (y, m) => {
  const days = [], d = new Date(y, m, 1);
  while (d.getMonth() === m) { days.push(fmt(new Date(d))); d.setDate(d.getDate()+1); }
  return days;
};
const monthLabel = (y,m) => new Date(y,m,1).toLocaleDateString("en-GB",{month:"long",year:"numeric"});
const dowLabel   = (s) => { const d=parseD(s); return DAYS_SHORT[d.getDay()===0?6:d.getDay()-1]; };
const isWeekend  = (s) => { const d=parseD(s); return d.getDay()===0||d.getDay()===6; };

// ── Quota computation ──────────────────────────────────────
const computeQuota = (requests) => {
  const byDate = {};
  requests.forEach(r => {
    if (r.type !== "leave") return;
    if (!byDate[r.date]) byDate[r.date] = [];
    byDate[r.date].push(r);
  });
  const qMap = {};
  Object.entries(byDate).forEach(([date, reqs]) => {
    const sorted = [...reqs].sort((a,b) => new Date(a.submitted_at) - new Date(b.submitted_at));
    qMap[date] = sorted.map((r,i) => ({ ...r, status: i < LEAVE_QUOTA ? "approved" : "waitlist" }));
  });
  return qMap;
};

// ── Mini components ────────────────────────────────────────
const Pill = ({ children, color="#1e3a5f", text="#60a5fa" }) => (
  <span style={{
    display:"inline-flex",alignItems:"center",fontSize:9,fontWeight:700,
    letterSpacing:.8,padding:"2px 7px",borderRadius:20,
    background:color,color:text,textTransform:"uppercase",whiteSpace:"nowrap"
  }}>{children}</span>
);

const Avatar = ({ name, type, size=32 }) => (
  <div style={{
    width:size,height:size,borderRadius:size*0.3,flexShrink:0,
    background:type==="stable"?"linear-gradient(135deg,#14532d,#166534)":"linear-gradient(135deg,#4a1d96,#6d28d9)",
    display:"flex",alignItems:"center",justifyContent:"center",
    fontWeight:800,color:"#fff",fontSize:size*0.35
  }}>
    {name.split(" ").map(n=>n[0]).join("").slice(0,2)}
  </div>
);

// ── Drag-and-drop shift cell ───────────────────────────────
const ShiftCell = ({ empId, employees, date, desk, deskId, shift, onDrop, onClear, onClick }) => {
  const [over, setOver] = useState(false);
  const emp = employees.find(e => e.id === empId);
  return (
    <div
      draggable={!!empId}
      onDragStart={e => e.dataTransfer.setData("sd", JSON.stringify({ empId, date, desk, deskId, shift }))}
      onDragOver={e => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={e => { e.preventDefault(); setOver(false); onDrop(JSON.parse(e.dataTransfer.getData("sd")), { empId, date, desk, deskId, shift }); }}
      onClick={() => emp && onClick(emp)}
      style={{
        minHeight:54,padding:"8px 12px",borderRadius:8,cursor:emp?"grab":"default",
        background:over?"#1e3a5f22":emp?"#0d1f2d":"#090e1a",
        border:`1px solid ${over?"#3b82f6":emp?"#1e2d4588":"#1a2535"}`,
        display:"flex",alignItems:"center",gap:8,transition:"all .15s",
        boxShadow:over?"0 0 0 2px #3b82f6":"none",
      }}
    >
      {emp ? (
        <>
          <Avatar name={emp.name} type={emp.type} size={28}/>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:12,fontWeight:600,color:"#e2e8f0",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
              {emp.name.split(" ")[0]}
            </div>
            <Pill color={emp.type==="stable"?"#14532d22":"#4a1d9622"} text={emp.type==="stable"?"#4ade80":"#c084fc"}>
              {emp.type==="stable"?"Staff":"Vol"}
            </Pill>
          </div>
          <button onClick={e=>{e.stopPropagation();onClear(date,deskId,shift);}} style={{
            background:"none",border:"none",color:"#475569",cursor:"pointer",fontSize:14,padding:"2px 4px"
          }}>✕</button>
        </>
      ) : (
        <span style={{fontSize:11,color:"#334155",fontStyle:"italic"}}>Unassigned — drop here</span>
      )}
    </div>
  );
};

// ══════════════════════════════════════════════════════════
// MAIN APP
// ══════════════════════════════════════════════════════════
export default function ShiftDeskSupabase() {
  const today = new Date();
  const [year,  setYear]  = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());

  // ── Live data from Supabase ──
  const [employees,  setEmployees]  = useState([]);
  const [desks,      setDesks]      = useState([]);
  const [holidays,   setHolidays]   = useState(new Set());
  const [requests,   setRequests]   = useState([]);   // leave_requests rows
  const [shifts,     setShifts]     = useState([]);   // shifts rows
  const [loading,    setLoading]    = useState(true);
  const [dbError,    setDbError]    = useState(false);

  // ── UI state ──
  const [view,         setView]        = useState("schedule");
  const [selectedDate, setSelectedDate]= useState(null);
  const [modal,        setModal]       = useState(null);
  const [toast,        setToast]       = useState(null);
  const [portalEmpId,  setPortalEmpId] = useState("");
  const [portalDate,   setPortalDate]  = useState("");
  const [portalType,   setPortalType]  = useState("leave");
  const [calMonth,     setCalMonth]    = useState(today.getMonth());
  const [calYear,      setCalYear]     = useState(today.getFullYear());
  const toastRef = useRef(null);

  const showToast = (msg, type="success") => {
    clearTimeout(toastRef.current);
    setToast({ msg, type });
    toastRef.current = setTimeout(() => setToast(null), 3200);
  };

  // ── Load all data from Supabase ──────────────────────────
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [emps, dsk, hols, reqs, shfts] = await Promise.all([
          supa.select("employees"),
          supa.select("desks"),
          supa.select("holidays"),
          supa.select("leave_requests"),
          supa.select("shifts", `date=gte.${year}-${String(month+1).padStart(2,"0")}-01&date=lte.${year}-${String(month+1).padStart(2,"0")}-31`),
        ]);
        if (!Array.isArray(emps)) throw new Error("DB connection failed");
        setEmployees(emps);
        setDesks(dsk);
        setHolidays(new Set((hols||[]).map(h=>h.date)));
        setRequests(reqs||[]);
        setShifts(shfts||[]);
        if (emps.length) setPortalEmpId(emps[0].id);
        setDbError(false);
      } catch (e) {
        console.error(e);
        setDbError(true);
      } finally {
        setLoading(false);
      }
    })();
  }, [year, month]);

  // ── Reload shifts when month changes ────────────────────
  useEffect(() => {
    const days = getDaysInMonth(year, month);
    if (days.length) setSelectedDate(days[0]);
  }, [year, month]);

  // ── Realtime subscriptions ───────────────────────────────
  useEffect(() => {
    const unsubShifts = supa.subscribe("shifts", (event, record, old) => {
      setShifts(prev => {
        if (event === "INSERT") return [...prev, record];
        if (event === "UPDATE") return prev.map(s => s.id === record.id ? record : s);
        if (event === "DELETE") return prev.filter(s => s.id !== old?.id);
        return prev;
      });
    });
    const unsubReqs = supa.subscribe("leave_requests", (event, record, old) => {
      setRequests(prev => {
        if (event === "INSERT") return [...prev, record];
        if (event === "DELETE") return prev.filter(r => r.id !== old?.id);
        return prev;
      });
    });
    return () => { unsubShifts(); unsubReqs(); };
  }, []);

  // ── Derived data ─────────────────────────────────────────
  const quotaMap   = computeQuota(requests);
  const days       = getDaysInMonth(year, month);
  const deskNames  = desks.map(d => d.name);

  // Build a lookup: shifts["2026-06-01"][deskId]["Morning (8–13)"] = employeeId
  const shiftLookup = {};
  shifts.forEach(s => {
    if (!shiftLookup[s.date]) shiftLookup[s.date] = {};
    if (!shiftLookup[s.date][s.desk_id]) shiftLookup[s.date][s.desk_id] = {};
    shiftLookup[s.date][s.desk_id][s.shift_label] = s.employee_id;
  });

  // Stats
  let total = 0, filled = 0;
  shifts.forEach(s => { total++; if (s.employee_id) filled++; });
  const approvedCount = Object.values(quotaMap).flat().filter(r=>r.status==="approved").length;
  const waitlistCount = Object.values(quotaMap).flat().filter(r=>r.status==="waitlist").length;

  // ── Auto-generate shifts for a month ────────────────────
  const generateMonthSchedule = async () => {
    showToast("Generating schedule…", "info");
    const assignCount = {};
    employees.filter(e=>e.active).forEach(e => assignCount[e.id] = 0);

    const rows = [];
    for (const date of days) {
      if (holidays.has(date) || isWeekend(date)) continue;
      const approvedLeaves = new Set((quotaMap[date]||[]).filter(r=>r.status==="approved").map(r=>r.employee_id));
      const backOffice = new Set(requests.filter(r=>r.date===date&&r.type==="backoffice").map(r=>r.employee_id));
      const unavailable = new Set([...approvedLeaves, ...backOffice]);

      for (const desk of desks) {
        for (const shift of SHIFTS) {
          const pool = employees.filter(e=>e.active && !unavailable.has(e.id))
            .sort((a,b) => {
              if (a.type !== b.type) return a.type==="stable" ? -1 : 1;
              return (assignCount[a.id]||0) - (assignCount[b.id]||0);
            });
          const picked = pool[0] || null;
          if (picked) assignCount[picked.id]++;
          rows.push({ date, desk_id: desk.id, shift_label: shift, employee_id: picked?.id || null });
        }
      }
    }
    // Batch upsert
    for (const row of rows) {
      await supa.upsert("shifts", row, "date,desk_id,shift_label");
    }
    // Reload
    const fresh = await supa.select("shifts", `date=gte.${year}-${String(month+1).padStart(2,"0")}-01`);
    setShifts(fresh||[]);
    showToast("Schedule generated ✓");
  };

  // ── Drag & Drop ─────────────────────────────────────────
  const handleDrop = useCallback(async (from, to) => {
    if (from.date===to.date && from.deskId===to.deskId && from.shift===to.shift) return;
    const fromShift = shifts.find(s=>s.date===from.date&&s.desk_id===from.deskId&&s.shift_label===from.shift);
    const toShift   = shifts.find(s=>s.date===to.date  &&s.desk_id===to.deskId  &&s.shift_label===to.shift);
    if (fromShift) await supa.update("shifts", { id: fromShift.id }, { employee_id: to.empId || null });
    if (toShift)   await supa.update("shifts", { id: toShift.id   }, { employee_id: from.empId });
    showToast("Shift swapped ✓");
  }, [shifts]);

  const handleClear = useCallback(async (date, deskId, shift) => {
    const s = shifts.find(s=>s.date===date&&s.desk_id===deskId&&s.shift_label===shift);
    if (s) { await supa.update("shifts", { id: s.id }, { employee_id: null }); showToast("Slot cleared"); }
  }, [shifts]);

  // ── Submit leave / back-office request ──────────────────
  const submitRequest = async () => {
    if (!portalDate) { showToast("Pick a date first","error"); return; }
    const d = parseD(portalDate);
    if (d.getMonth()!==calMonth||d.getFullYear()!==calYear) {
      showToast("Date must be in selected month","error"); return;
    }
    const exists = requests.find(r=>r.employee_id===portalEmpId&&r.date===portalDate&&r.type===portalType);
    if (exists) { showToast("Already requested for this date","error"); return; }
    const result = await supa.insert("leave_requests", { employee_id:portalEmpId, date:portalDate, type:portalType });
    if (Array.isArray(result) && result[0]) {
      setRequests(prev => [...prev, result[0]]);
      showToast(`${portalType==="leave"?"Leave":"Back-office"} request submitted ✓`);
      setPortalDate("");
    } else {
      showToast("Error submitting request","error");
    }
  };

  const cancelRequest = async (id) => {
    await supa.delete("leave_requests", { id });
    setRequests(prev => prev.filter(r=>r.id!==id));
    showToast("Request cancelled");
  };

  // ── Calendar date status for portal ─────────────────────
  const getDateStatus = (date) => {
    if (holidays.has(date)) return "holiday";
    if (isWeekend(date)) return "weekend";
    const myReq = requests.find(r=>r.employee_id===portalEmpId&&r.date===date);
    if (myReq) {
      if (myReq.type==="backoffice") return "backoffice";
      const q = (quotaMap[date]||[]).find(r=>r.employee_id===portalEmpId);
      return q?.status || "pending";
    }
    if ((quotaMap[date]||[]).filter(r=>r.status==="approved").length >= LEAVE_QUOTA) return "full";
    return null;
  };

  // ── Colours ─────────────────────────────────────────────
  const C = { bg:"#070c17",surface:"#0c1525",border:"#1a2535",accent:"#3b82f6",text:"#e2e8f0",muted:"#64748b",subtle:"#1e2d45" };

  const navItems = [
    {id:"schedule", label:"📅 Schedule"},
    {id:"portal",   label:"🏖 Leave Portal"},
    {id:"requests", label:"📋 Request Queue"},
    {id:"employees",label:"👥 Staff"},
  ];

  // ── DB not configured screen ─────────────────────────────
  if (dbError || SUPABASE_URL.includes("YOUR_PROJECT_ID")) {
    return (
      <div style={{minHeight:"100vh",background:C.bg,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"monospace",color:C.text,padding:32}}>
        <div style={{maxWidth:540,background:C.surface,border:"1px solid #f59e0b44",borderRadius:16,padding:32}}>
          <div style={{fontSize:28,marginBottom:8}}>⚙️</div>
          <div style={{fontSize:18,fontWeight:800,color:"#fbbf24",marginBottom:12}}>Supabase Not Connected</div>
          <p style={{color:C.muted,lineHeight:1.7,marginBottom:20}}>
            To connect to your live database, open this file and replace the two placeholder values at the top:
          </p>
          <div style={{background:"#0a0f1c",borderRadius:10,padding:16,fontSize:12,lineHeight:2,border:"1px solid #1e2d45"}}>
            <div><span style={{color:"#64748b"}}>// Line 9:</span></div>
            <div><span style={{color:"#f59e0b"}}>const SUPABASE_URL</span> = <span style={{color:"#4ade80"}}>&quot;https://abcdefgh.supabase.co&quot;</span>;</div>
            <div style={{marginTop:8}}><span style={{color:"#64748b"}}>// Line 10:</span></div>
            <div><span style={{color:"#f59e0b"}}>const SUPABASE_ANON</span> = <span style={{color:"#4ade80"}}>&quot;eyJhbGci...&quot;</span>;</div>
          </div>
          <p style={{color:C.muted,fontSize:12,marginTop:16}}>
            Find both values in: <strong style={{color:"#93c5fd"}}>Supabase Dashboard → Settings → API</strong>
          </p>
        </div>
      </div>
    );
  }

  // ── Loading screen ───────────────────────────────────────
  if (loading) {
    return (
      <div style={{minHeight:"100vh",background:C.bg,display:"flex",alignItems:"center",justifyContent:"center",color:C.muted,fontFamily:"monospace",flexDirection:"column",gap:16}}>
        <div style={{width:40,height:40,border:"3px solid #1e2d45",borderTop:"3px solid #3b82f6",borderRadius:"50%",animation:"spin 1s linear infinite"}}/>
        <div>Connecting to Supabase…</div>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    );
  }

  const calDays   = getDaysInMonth(calYear, calMonth);
  const calOffset = (() => { const d=parseD(calDays[0]); return d.getDay()===0?6:d.getDay()-1; })();

  return (
    <div style={{minHeight:"100vh",background:C.bg,color:C.text,fontFamily:"'DM Mono','Fira Mono',monospace",display:"flex",flexDirection:"column"}}>

      {/* Toast */}
      {toast && (
        <div style={{
          position:"fixed",top:16,right:16,zIndex:999,padding:"10px 18px",borderRadius:10,
          fontSize:13,fontWeight:600,boxShadow:"0 8px 32px #00000088",
          background:toast.type==="error"?"#7f1d1d":toast.type==="info"?"#1e3a8a":"#14532d",
          color:toast.type==="error"?"#fca5a5":toast.type==="info"?"#93c5fd":"#86efac",
          border:`1px solid ${toast.type==="error"?"#ef444422":toast.type==="info"?"#3b82f622":"#22c55e22"}`,
        }}>{toast.msg}</div>
      )}

      {/* Header */}
      <div style={{background:"linear-gradient(90deg,#0c1525,#0f1e35)",borderBottom:`1px solid ${C.border}`,padding:"0 24px",display:"flex",alignItems:"stretch",position:"sticky",top:0,zIndex:100}}>
        <div style={{display:"flex",alignItems:"center",gap:12,marginRight:28,paddingRight:28,borderRight:`1px solid ${C.border}`}}>
          <div style={{width:36,height:36,borderRadius:10,background:"linear-gradient(135deg,#3b82f6,#6366f1)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>🗓</div>
          <div>
            <div style={{fontSize:15,fontWeight:800,letterSpacing:-1,color:"#f1f5f9"}}>ShiftDesk <span style={{color:C.accent}}>Pro</span></div>
            <div style={{fontSize:8,color:C.muted,letterSpacing:2}}>LIVE · SUPABASE</div>
          </div>
        </div>
        <div style={{display:"flex",flex:1}}>
          {navItems.map(n=>(
            <button key={n.id} onClick={()=>setView(n.id)} style={{
              background:"none",border:"none",cursor:"pointer",padding:"0 16px",fontFamily:"inherit",
              borderBottom:`3px solid ${view===n.id?C.accent:"transparent"}`,
              color:view===n.id?"#f1f5f9":C.muted,fontWeight:700,fontSize:12,transition:"all .15s",
            }}>{n.label}</button>
          ))}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8,paddingLeft:20,borderLeft:`1px solid ${C.border}`}}>
          <button onClick={()=>{if(month===0){setMonth(11);setYear(y=>y-1);}else setMonth(m=>m-1);}} 
            style={{background:C.subtle,border:"none",color:C.text,cursor:"pointer",borderRadius:7,width:28,height:28,fontSize:15}}>‹</button>
          <div style={{minWidth:130,textAlign:"center",fontSize:12,fontWeight:700,color:"#f1f5f9"}}>{monthLabel(year,month)}</div>
          <button onClick={()=>{if(month===11){setMonth(0);setYear(y=>y+1);}else setMonth(m=>m+1);}} 
            style={{background:C.subtle,border:"none",color:C.text,cursor:"pointer",borderRadius:7,width:28,height:28,fontSize:15}}>›</button>
        </div>
      </div>

      {/* Stats */}
      <div style={{display:"flex",gap:10,padding:"10px 24px",background:"#090e1a",borderBottom:`1px solid ${C.border}`,flexWrap:"wrap"}}>
        {[
          {l:"WORK DAYS",   v:days.filter(d=>!holidays.has(d)&&!isWeekend(d)).length, c:"#60a5fa"},
          {l:"FILLED",      v:`${filled}/${total}`,  c:"#34d399"},
          {l:"ACTIVE STAFF",v:employees.filter(e=>e.active).length, c:"#a78bfa"},
          {l:"APPROVED",    v:approvedCount,  c:"#fbbf24"},
          {l:"WAITLIST",    v:waitlistCount,  c:"#f87171"},
          {l:"HOLIDAYS",    v:days.filter(d=>holidays.has(d)).length, c:"#fb923c"},
        ].map(s=>(
          <div key={s.l} style={{background:`${s.c}0d`,border:`1px solid ${s.c}22`,borderRadius:10,padding:"8px 14px",minWidth:100}}>
            <div style={{fontSize:20,fontWeight:800,color:s.c,lineHeight:1}}>{s.v}</div>
            <div style={{fontSize:8,color:C.muted,marginTop:3,letterSpacing:1}}>{s.l}</div>
          </div>
        ))}
        {view==="schedule" && (
          <button onClick={generateMonthSchedule} style={{
            marginLeft:"auto",background:"linear-gradient(135deg,#1d4ed8,#4f46e5)",
            border:"none",color:"#fff",padding:"8px 18px",borderRadius:10,
            cursor:"pointer",fontWeight:700,fontSize:12,fontFamily:"inherit",
          }}>⚡ Generate Schedule</button>
        )}
      </div>

      {/* ── SCHEDULE VIEW ── */}
      {view==="schedule" && (
        <div style={{display:"flex",flex:1,overflow:"hidden"}}>
          {/* Day sidebar */}
          <div style={{width:180,flexShrink:0,borderRight:`1px solid ${C.border}`,overflowY:"auto",background:"#090e1a"}}>
            <div style={{padding:"10px 14px",fontSize:9,fontWeight:700,color:C.muted,letterSpacing:2,borderBottom:`1px solid ${C.border}`}}>
              {monthLabel(year,month).toUpperCase()}
            </div>
            {days.map(date=>{
              const hol=holidays.has(date), wkd=isWeekend(date), active=selectedDate===date;
              const aCount=(quotaMap[date]||[]).filter(r=>r.status==="approved").length;
              return (
                <div key={date} onClick={()=>setSelectedDate(date)} style={{
                  padding:"8px 14px",cursor:"pointer",borderBottom:`1px solid ${C.border}11`,
                  background:active?"#1e3a8a22":hol?"#7c2d1222":wkd?"#1e2d4511":"transparent",
                  borderLeft:`3px solid ${active?C.accent:hol?"#f97316":wkd?"#334155":"transparent"}`,
                  display:"flex",justifyContent:"space-between",alignItems:"center",
                }}>
                  <div>
                    <div style={{fontSize:11,fontWeight:700,color:active?"#93c5fd":hol?"#fb923c":wkd?"#475569":"#94a3b8"}}>
                      {dowLabel(date)} {parseD(date).getDate()}
                    </div>
                    {hol && <div style={{fontSize:9,color:"#fb923c"}}>Holiday</div>}
                  </div>
                  {aCount>0 && <span style={{fontSize:9,color:"#fbbf24"}}>🏖{aCount}</span>}
                </div>
              );
            })}
          </div>

          {/* Shift grid */}
          <div style={{flex:1,overflowY:"auto",padding:20}}>
            {selectedDate && (
              <>
                <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:18}}>
                  <div style={{fontSize:18,fontWeight:800,color:"#f1f5f9"}}>
                    {dowLabel(selectedDate)}, {parseD(selectedDate).toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"})}
                  </div>
                  {holidays.has(selectedDate) && <Pill color="#7c2d1111" text="#fb923c">Holiday</Pill>}
                </div>

                {holidays.has(selectedDate) ? (
                  <div style={{textAlign:"center",padding:60,color:"#fb923c",fontSize:15}}>
                    🎉 Official holiday — no shifts scheduled.
                  </div>
                ) : (
                  <div style={{display:"grid",gap:6}}>
                    <div style={{display:"grid",gridTemplateColumns:"150px 1fr 1fr",gap:6,marginBottom:4}}>
                      <div style={{fontSize:9,fontWeight:700,color:C.muted,letterSpacing:1}}>DESK</div>
                      {SHIFTS.map(s=><div key={s} style={{fontSize:9,fontWeight:700,color:C.muted,letterSpacing:1}}>{s.toUpperCase()}</div>)}
                    </div>
                    {desks.map((desk,di)=>(
                      <div key={desk.id} style={{display:"grid",gridTemplateColumns:"150px 1fr 1fr",gap:6,background:di%2===0?"#0c152544":"transparent",borderRadius:8}}>
                        <div style={{display:"flex",alignItems:"center",gap:6,padding:"0 10px",fontSize:11,fontWeight:600,color:"#94a3b8"}}>
                          🖥 {desk.name}
                        </div>
                        {SHIFTS.map(shift=>(
                          <ShiftCell
                            key={shift}
                            empId={shiftLookup[selectedDate]?.[desk.id]?.[shift] || null}
                            employees={employees}
                            date={selectedDate} desk={desk.name} deskId={desk.id} shift={shift}
                            onDrop={handleDrop} onClear={handleClear}
                            onClick={emp=>setModal({type:"empDetail",emp})}
                          />
                        ))}
                      </div>
                    ))}
                    <div style={{marginTop:8,padding:10,background:"#1e2d4522",borderRadius:8,fontSize:10,color:C.muted}}>
                      💡 Drag any employee to swap shifts. Changes save instantly to Supabase.
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* ── LEAVE PORTAL ── */}
      {view==="portal" && (
        <div style={{flex:1,overflowY:"auto",padding:24,display:"grid",gridTemplateColumns:"1fr 1fr",gap:20,alignItems:"start"}}>
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:22}}>
            <div style={{fontSize:15,fontWeight:800,marginBottom:18,color:"#f1f5f9"}}>🏖 Submit Request</div>
            <div style={{display:"grid",gap:12}}>
              <div>
                <label style={{fontSize:10,color:C.muted,letterSpacing:1,display:"block",marginBottom:5}}>EMPLOYEE</label>
                <select value={portalEmpId} onChange={e=>setPortalEmpId(e.target.value)} style={{width:"100%",background:"#070c17",border:`1px solid ${C.border}`,color:C.text,padding:"8px 10px",borderRadius:8,fontSize:12,fontFamily:"inherit"}}>
                  {employees.filter(e=>e.active).map(e=>(
                    <option key={e.id} value={e.id}>{e.name} ({e.type==="stable"?"Staff":"Vol"})</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={{fontSize:10,color:C.muted,letterSpacing:1,display:"block",marginBottom:5}}>TYPE</label>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  {[{v:"leave",label:"🏖 Leave",desc:"Away from office"},{v:"backoffice",label:"🏢 Back-Office",desc:"No shifts, office work"}].map(opt=>(
                    <button key={opt.v} onClick={()=>setPortalType(opt.v)} style={{
                      padding:"10px",borderRadius:9,border:`2px solid ${portalType===opt.v?C.accent:C.border}`,
                      background:portalType===opt.v?"#1e3a8a22":"transparent",cursor:"pointer",textAlign:"left",fontFamily:"inherit",
                    }}>
                      <div style={{fontSize:12,fontWeight:700,color:portalType===opt.v?"#93c5fd":"#94a3b8"}}>{opt.label}</div>
                      <div style={{fontSize:9,color:C.muted,marginTop:2}}>{opt.desc}</div>
                    </button>
                  ))}
                </div>
              </div>
              {/* Month picker for calendar */}
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <button onClick={()=>{if(calMonth===0){setCalMonth(11);setCalYear(y=>y-1);}else setCalMonth(m=>m-1);}} 
                  style={{background:C.subtle,border:"none",color:C.text,cursor:"pointer",borderRadius:6,width:26,height:26,fontSize:14}}>‹</button>
                <span style={{flex:1,textAlign:"center",fontSize:11,fontWeight:700}}>{monthLabel(calYear,calMonth)}</span>
                <button onClick={()=>{if(calMonth===11){setCalMonth(0);setCalYear(y=>y+1);}else setCalMonth(m=>m+1);}} 
                  style={{background:C.subtle,border:"none",color:C.text,cursor:"pointer",borderRadius:6,width:26,height:26,fontSize:14}}>›</button>
              </div>
              {/* Mini calendar */}
              <div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:2,marginBottom:4}}>
                  {["M","T","W","T","F","S","S"].map((d,i)=>(
                    <div key={i} style={{textAlign:"center",fontSize:8,color:C.muted,fontWeight:700,padding:"3px 0"}}>{d}</div>
                  ))}
                  {Array.from({length:calOffset}).map((_,i)=><div key={`e${i}`}/>)}
                  {calDays.map(date=>{
                    const st=getDateStatus(date);
                    const sel=portalDate===date;
                    const past=parseD(date)<new Date();
                    const bg=sel?"#1d4ed8":st==="approved"?"#14532d":st==="waitlist"?"#78350f":st==="backoffice"?"#4a1d96":st==="holiday"?"#7c2d12":st==="weekend"?"#1e2d45":st==="full"?"#1c1c2e":"transparent";
                    const tc=sel?"#fff":st==="approved"?"#4ade80":st==="waitlist"?"#fbbf24":st==="backoffice"?"#c084fc":st==="holiday"?"#fb923c":st==="weekend"?"#334155":st==="full"?"#475569":past?"#334155":"#94a3b8";
                    const clickable=!past&&st!=="holiday"&&st!=="weekend";
                    return (
                      <button key={date} onClick={()=>clickable&&setPortalDate(date)} style={{
                        background:bg,border:`1px solid ${sel?"#3b82f6":C.border+"22"}`,borderRadius:5,
                        padding:"4px 2px",cursor:clickable?"pointer":"default",
                        fontSize:10,fontWeight:sel?700:400,color:tc,textAlign:"center",transition:"all .1s",fontFamily:"inherit",
                      }}>{parseD(date).getDate()}</button>
                    );
                  })}
                </div>
                <div style={{display:"flex",gap:8,flexWrap:"wrap",fontSize:8,color:C.muted,marginTop:6}}>
                  {[["#4ade80","Approved"],["#fbbf24","Waitlist"],["#c084fc","Back-office"],["#fb923c","Holiday"],["#475569","Full (5/5)"]].map(([c,l])=>(
                    <span key={l} style={{display:"flex",alignItems:"center",gap:3}}>
                      <span style={{width:7,height:7,borderRadius:2,background:c,display:"inline-block"}}/>
                      {l}
                    </span>
                  ))}
                </div>
              </div>
              {portalDate && (
                <div style={{background:"#1e3a8a11",border:`1px solid ${C.accent}33`,borderRadius:8,padding:10,fontSize:11}}>
                  <strong style={{color:"#93c5fd"}}>Selected:</strong> {portalDate}
                  {portalType==="leave" && (quotaMap[portalDate]||[]).filter(r=>r.status==="approved").length >= LEAVE_QUOTA &&
                    <div style={{color:"#fbbf24",marginTop:3}}>⚠ Quota full — will be waitlisted</div>}
                </div>
              )}
              <button onClick={submitRequest} style={{
                background:"linear-gradient(135deg,#1d4ed8,#4f46e5)",border:"none",color:"#fff",
                padding:"11px",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit",
              }}>Submit Request →</button>
            </div>
          </div>

          {/* My requests panel */}
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:22}}>
            <div style={{fontSize:14,fontWeight:800,marginBottom:14,color:"#f1f5f9"}}>
              My Requests — {employees.find(e=>e.id===portalEmpId)?.name}
            </div>
            {(() => {
              const myReqs = requests.filter(r=>r.employee_id===portalEmpId).sort((a,b)=>a.date.localeCompare(b.date));
              if (!myReqs.length) return <div style={{color:C.muted,fontSize:12,textAlign:"center",padding:20}}>No requests yet.</div>;
              return myReqs.map(req=>{
                const isBO = req.type==="backoffice";
                const q = isBO ? null : (quotaMap[req.date]||[]).find(r=>r.employee_id===portalEmpId);
                const status = isBO ? "backoffice" : q?.status || "pending";
                const statusColor = status==="approved"?"#4ade80":status==="waitlist"?"#fbbf24":status==="backoffice"?"#c084fc":"#64748b";
                return (
                  <div key={req.id} style={{
                    display:"flex",alignItems:"center",gap:10,padding:"9px 11px",marginBottom:6,borderRadius:9,
                    background:`${statusColor}08`,border:`1px solid ${statusColor}22`,
                  }}>
                    <span style={{fontSize:14}}>{isBO?"🏢":"🏖"}</span>
                    <div style={{flex:1}}>
                      <div style={{fontSize:12,fontWeight:600,color:"#e2e8f0"}}>{req.date}</div>
                      <div style={{fontSize:9,color:C.muted}}>{dowLabel(req.date)} · {isBO?"Back-Office":"Leave"}</div>
                    </div>
                    <Pill color={`${statusColor}22`} text={statusColor}>{status}</Pill>
                    <button onClick={()=>cancelRequest(req.id)} style={{background:"none",border:"none",color:"#ef4444",cursor:"pointer",fontSize:12}}>✕</button>
                  </div>
                );
              });
            })()}
          </div>
        </div>
      )}

      {/* ── REQUEST QUEUE ── */}
      {view==="requests" && (
        <div style={{flex:1,overflowY:"auto",padding:24}}>
          <div style={{fontSize:15,fontWeight:800,color:"#f1f5f9",marginBottom:18}}>
            📋 Daily Leave Queue — {monthLabel(year,month)}
          </div>
          {Object.entries(quotaMap)
            .filter(([d])=>{const dd=parseD(d);return dd.getMonth()===month&&dd.getFullYear()===year;})
            .sort(([a],[b])=>a.localeCompare(b))
            .map(([date,reqs])=>(
              <div key={date} style={{marginBottom:16}}>
                <div style={{display:"flex",alignItems:"center",gap:10,padding:"8px 14px",background:C.surface,border:`1px solid ${C.border}`,borderRadius:"10px 10px 0 0"}}>
                  <span style={{fontWeight:700,fontSize:12,color:"#f1f5f9"}}>{dowLabel(date)} · {parseD(date).toLocaleDateString("en-GB",{day:"numeric",month:"short"})}</span>
                  <span style={{fontSize:10,color:"#34d399"}}>✓ {reqs.filter(r=>r.status==="approved").length}/{LEAVE_QUOTA}</span>
                  {reqs.filter(r=>r.status==="waitlist").length>0 && <span style={{fontSize:10,color:"#fbbf24"}}>⏳ {reqs.filter(r=>r.status==="waitlist").length} waiting</span>}
                  <div style={{flex:1,height:5,background:"#1e2d45",borderRadius:3,marginLeft:8,overflow:"hidden"}}>
                    <div style={{height:"100%",borderRadius:3,width:`${Math.min(100,(reqs.filter(r=>r.status==="approved").length/LEAVE_QUOTA)*100)}%`,background:reqs.filter(r=>r.status==="approved").length>=LEAVE_QUOTA?"#ef4444":"#22c55e"}}/>
                  </div>
                </div>
                <div style={{border:`1px solid ${C.border}`,borderTop:"none",borderRadius:"0 0 10px 10px",overflow:"hidden"}}>
                  {reqs.map((r,i)=>(
                    <div key={r.id} style={{
                      display:"flex",alignItems:"center",gap:10,padding:"8px 14px",
                      background:r.status==="approved"?"#14532d08":"#78350f08",
                      borderBottom:i<reqs.length-1?`1px solid ${C.border}22`:"none",
                    }}>
                      <div style={{width:20,height:20,borderRadius:5,background:r.status==="approved"?"#14532d":"#78350f",display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:800,color:"#fff",flexShrink:0}}>{i+1}</div>
                      <span style={{flex:1,fontSize:12,fontWeight:600,color:"#e2e8f0"}}>{r.empName || r.employee_id}</span>
                      <Pill color={r.status==="approved"?"#14532d22":"#78350f22"} text={r.status==="approved"?"#4ade80":"#fbbf24"}>
                        {r.status==="approved"?"✓ Approved":"⏳ Waitlist"}
                      </Pill>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          {Object.keys(quotaMap).filter(d=>{const dd=parseD(d);return dd.getMonth()===month&&dd.getFullYear()===year;}).length===0 && (
            <div style={{textAlign:"center",padding:60,color:C.muted,fontSize:13}}>No leave requests for {monthLabel(year,month)}.</div>
          )}
        </div>
      )}

      {/* ── STAFF VIEW ── */}
      {view==="employees" && (
        <div style={{flex:1,overflowY:"auto",padding:24}}>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(270px,1fr))",gap:12}}>
            {employees.map(emp=>{
              const empReqs=requests.filter(r=>r.employee_id===emp.id);
              const approved=empReqs.filter(r=>{const q=(quotaMap[r.date]||[]).find(x=>x.employee_id===emp.id);return q?.status==="approved";});
              const boDays=empReqs.filter(r=>r.type==="backoffice");
              return (
                <div key={emp.id} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:15,opacity:emp.active?1:.45}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                    <div style={{display:"flex",gap:10}}>
                      <Avatar name={emp.name} type={emp.type} size={38}/>
                      <div>
                        <div style={{fontWeight:700,fontSize:13,color:"#f1f5f9"}}>{emp.name}</div>
                        <div style={{fontSize:9,color:C.muted}}>{emp.id} · {emp.email}</div>
                      </div>
                    </div>
                    <Pill color={emp.type==="stable"?"#14532d22":"#4a1d9622"} text={emp.type==="stable"?"#4ade80":"#c084fc"}>
                      {emp.type==="stable"?"Staff":"Vol"}
                    </Pill>
                  </div>
                  <div style={{display:"flex",gap:10,fontSize:10,color:C.muted}}>
                    <span>🏖 {approved.length} leaves</span>
                    <span>🏢 {boDays.length} back-office</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Modal */}
      {modal && (
        <div style={{position:"fixed",inset:0,zIndex:200,background:"#00000099",display:"flex",alignItems:"center",justifyContent:"center"}}
          onClick={()=>setModal(null)}>
          <div style={{background:"#0c1525",border:`1px solid ${C.border}`,borderRadius:16,padding:26,minWidth:340,maxWidth:420}}
            onClick={e=>e.stopPropagation()}>
            {modal.type==="empDetail" && (
              <>
                <div style={{display:"flex",gap:12,alignItems:"center",marginBottom:18}}>
                  <Avatar name={modal.emp.name} type={modal.emp.type} size={42}/>
                  <div>
                    <div style={{fontWeight:800,fontSize:16,color:"#f1f5f9"}}>{modal.emp.name}</div>
                    <div style={{fontSize:10,color:C.muted}}>{modal.emp.id} · {modal.emp.email}</div>
                  </div>
                </div>
                <div style={{fontSize:12,color:C.muted,lineHeight:2}}>
                  <div>📞 {modal.emp.phone}</div>
                  <div>🏷 <Pill color={modal.emp.type==="stable"?"#14532d22":"#4a1d9622"} text={modal.emp.type==="stable"?"#4ade80":"#c084fc"}>{modal.emp.type==="stable"?"Stable Staff":"Volunteer"}</Pill></div>
                </div>
                <div style={{display:"flex",justifyContent:"flex-end",marginTop:18}}>
                  <button onClick={()=>setModal(null)} style={{background:C.subtle,border:"none",color:C.text,padding:"7px 18px",borderRadius:8,cursor:"pointer",fontWeight:600,fontFamily:"inherit",fontSize:12}}>Close</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <style>{`
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: #070c17; }
        ::-webkit-scrollbar-thumb { background: #1e2d45; border-radius: 3px; }
        select option { background: #0c1525; }
      `}</style>
    </div>
  );
}