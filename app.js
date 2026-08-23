import React, { useState, useEffect, useMemo, useRef } from "react";
import { Plus, Trash2, Upload, ChevronRight, ChevronUp, ChevronDown, Package, AlertTriangle, CalendarDays, MessageSquare, LayoutDashboard, X, Pencil, Link2, Copy, LogOut } from "lucide-react";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getStorage, ref, uploadString, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-storage.js";

// ---------- Firebase setup ----------
// Fill these in with the values from your Firebase project settings
// (Project settings → General → Your apps → SDK setup and configuration).
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};
const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);
const storage = getStorage(firebaseApp);

// ---------- color tokens (inline style, NOT Tailwind arbitrary classes) ----------
const C = {
  bg: "#F4F5F2",
  sidebarBg: "#EDEEEA",
  panelBg: "#FFFFFF",
  border: "#D9DBD5",
  borderLight: "#E3E4E0",
  ink: "#1B2430",
  inkHover: "#2A3646",
  muted: "#8A9099",
  mutedIcon: "#B4B7AF",
  teal: "#2F6F6B",
  tealBg: "#EAF3F2",
  tealBgLight: "#F4FAF9",
  red: "#C1443C",
  redBg: "#FBEDEC",
  redBgLight: "#FFF9F8",
  chipBg: "#EDEEEA",
  rowAlt: "#FAFAF8",
  selectedBg: "#DEE0D8",
  fieldBg: "#F0F1EC"
};

// ---------- helpers ----------
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const todayISO = () => new Date().toISOString().slice(0, 10);
const toDate = s => s ? new Date(s + "T00:00:00") : null;
const daysDiff = (planned, actual) => {
  if (!planned || !actual) return null;
  return Math.round((toDate(actual) - toDate(planned)) / 86400000);
};
const durationDays = (start, end) => {
  if (!start || !end) return null;
  return Math.round((toDate(end) - toDate(start)) / 86400000) + 1;
};
const addDays = (dateStr, n) => {
  const d = toDate(dateStr);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};
const fmt = s => s ? s : "—";
function DiffBadge({
  diff,
  suffix = "天"
}) {
  const base = {
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: "12px",
    fontWeight: 600
  };
  if (diff === null || diff === undefined) return /*#__PURE__*/React.createElement("span", {
    style: {
      ...base,
      color: C.muted,
      fontWeight: 400
    }
  }, "未填");
  if (diff === 0) return /*#__PURE__*/React.createElement("span", {
    style: {
      ...base,
      color: C.teal
    }
  }, "準時");
  if (diff > 0) return /*#__PURE__*/React.createElement("span", {
    style: {
      ...base,
      color: C.red
    }
  }, "延遲 ", diff, " ", suffix);
  return /*#__PURE__*/React.createElement("span", {
    style: {
      ...base,
      color: C.teal
    }
  }, "提前 ", Math.abs(diff), " ", suffix);
}

// ---------- dependency graph helpers ----------
function getDescendants(stageId, stages, acc = new Set()) {
  stages.forEach(s => {
    if ((s.dependsOn || []).includes(stageId) && !acc.has(s.id)) {
      acc.add(s.id);
      getDescendants(s.id, stages, acc);
    }
  });
  return acc;
}
function earliestAllowedStart(stage, stages) {
  const deps = (stage.dependsOn || []).map(id => stages.find(s => s.id === id)).filter(Boolean);
  if (deps.length === 0) return null;
  const refDates = deps.map(d => d.actualEnd || d.plannedEnd).filter(Boolean);
  if (refDates.length !== deps.length) return {
    partial: true,
    date: null
  };
  const latest = refDates.reduce((a, b) => toDate(a) > toDate(b) ? a : b);
  return {
    partial: false,
    date: addDays(latest, 1)
  };
}

// simplified cascade model — inherits max upstream delay, not a full CPM float calculation
function forecastDelay(stageId, stages, memo = {}) {
  if (memo[stageId] !== undefined) return memo[stageId];
  const stage = stages.find(s => s.id === stageId);
  if (!stage) return 0;
  if (stage.actualEnd && stage.plannedEnd) {
    const d = Math.max(0, daysDiff(stage.plannedEnd, stage.actualEnd));
    memo[stageId] = d;
    return d;
  }
  const deps = stage.dependsOn || [];
  const inherited = deps.length ? Math.max(...deps.map(id => forecastDelay(id, stages, memo))) : 0;
  let ownOverdue = 0;
  if (stage.plannedEnd && !stage.actualEnd && toDate(stage.plannedEnd) < toDate(todayISO())) {
    ownOverdue = daysDiff(stage.plannedEnd, todayISO());
  }
  const result = Math.max(inherited, ownOverdue);
  memo[stageId] = result;
  return result;
}

// ---------- default stage template ----------
// This is the starting template used the very first time (before the user
// customizes it via the "預設流程範本" tab). Once they save changes there,
// the customized version is stored under key "template:stages" and takes over.
const DEFAULT_STAGE_TEMPLATE = [{
  id: "t1",
  name: "新需求開案",
  unit: "產品",
  form: "新產品評估書",
  dependsOn: []
}, {
  id: "t2",
  name: "價格評估",
  unit: "業務",
  form: "報價單及新產品價格推廣狀況",
  dependsOn: []
}, {
  id: "t3",
  name: "原樣取得",
  unit: "產品",
  form: "請購單、採購單",
  dependsOn: []
}, {
  id: "t4",
  name: "向廠商購買樣品",
  unit: "產品",
  form: "請購單、採購單",
  dependsOn: []
}, {
  id: "t5",
  name: "制訂測試規範",
  unit: "產品",
  form: "新產品評估書",
  dependsOn: []
}, {
  id: "t6",
  name: "檢驗廠商樣品",
  unit: "",
  form: "",
  dependsOn: []
}, {
  id: "t7",
  name: "全尺寸量測",
  unit: "品保",
  form: "檢驗紀錄表",
  dependsOn: ["t6"]
}, {
  id: "t8",
  name: "功能測試",
  unit: "測試",
  form: "檢驗紀錄表",
  dependsOn: ["t6"]
}, {
  id: "t9",
  name: "壽命測試",
  unit: "工程",
  form: "測試報告",
  dependsOn: ["t6"]
}, {
  id: "t10",
  name: "一般常溫壽命測試",
  unit: "",
  form: "",
  dependsOn: ["t9"]
}, {
  id: "t11",
  name: "高低溫壽命測試",
  unit: "",
  form: "",
  dependsOn: ["t9"]
}, {
  id: "t12",
  name: "製作廠商驗收用圖面",
  unit: "",
  form: "",
  dependsOn: []
}, {
  id: "t13",
  name: "製作客戶承認用圖面",
  unit: "",
  form: "",
  dependsOn: []
}, {
  id: "t14",
  name: "廠內品號及BOM建立",
  unit: "",
  form: "",
  dependsOn: []
}];

// turns a template (list of {id, name, unit, form, dependsOn}) into real stage
// records for a newly created product — fresh ids, dependsOn remapped, all
// execution fields (dates/completed/notes) reset to empty.
function instantiateStages(template) {
  const idMap = {};
  const withNewIds = template.map(t => {
    const newId = uid();
    idMap[t.id] = newId;
    return {
      ...t,
      id: newId
    };
  });
  return withNewIds.map(t => ({
    id: t.id,
    name: t.name,
    unit: t.unit,
    content: "",
    form: t.form,
    plannedStart: "",
    plannedEnd: "",
    actualStart: "",
    actualEnd: "",
    completed: false,
    dependsOn: (t.dependsOn || []).map(oldId => idMap[oldId]).filter(Boolean),
    notes: []
  }));
}

// ---------- storage wrapper (Firestore-backed) ----------
// Every key/value pair lives as one document in the "kv" collection, doc id = key.
// This mirrors the original get/set interface as closely as possible so the rest
// of the app didn't need to change.
async function storageGet(key) {
  try {
    const snap = await getDoc(doc(db, "kv", key));
    return snap.exists() ? snap.data().value : null;
  } catch (e) {
    console.error("storageGet failed:", key, e);
    return null;
  }
}
async function storageSet(key, value) {
  try {
    await setDoc(doc(db, "kv", key), {
      value,
      updatedAt: Date.now()
    });
    return true;
  } catch (e) {
    console.error("storageSet failed:", key, e);
    return false;
  }
}
function NPITracker({
  user
}) {
  const [products, setProducts] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [samples, setSamples] = useState([]);
  const [stages, setStages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("process");
  const [showProductForm, setShowProductForm] = useState(false);
  const [editProduct, setEditProduct] = useState(null);
  const [saveError, setSaveError] = useState("");
  const [confirmDeleteProduct, setConfirmDeleteProduct] = useState(null);
  const [productStats, setProductStats] = useState({});
  const [template, setTemplate] = useState(DEFAULT_STAGE_TEMPLATE);
  const [sidebarWidth, setSidebarWidth] = useState(288);
  const [isDesktop, setIsDesktop] = useState(true);
  const containerRef = useRef(null);
  const draggingRef = useRef(false);
  useEffect(() => {
    (async () => {
      const saved = await storageGet("template:stages");
      if (saved) setTemplate(saved);
    })();
  }, []);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const onMove = e => {
      if (!draggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const newWidth = Math.min(480, Math.max(200, e.clientX - rect.left));
      setSidebarWidth(newWidth);
    };
    const onUp = () => {
      draggingRef.current = false;
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);
  const startDrag = e => {
    draggingRef.current = true;
    document.body.style.cursor = "col-resize";
    e.preventDefault();
  };
  useEffect(() => {
    (async () => {
      const list = await storageGet("products");
      setProducts(list || []);
      setLoading(false);
    })();
  }, []);
  useEffect(() => {
    if (!selectedId) {
      setSamples([]);
      setStages([]);
      return;
    }
    (async () => {
      const s = await storageGet(`samples:${selectedId}`);
      const p = await storageGet(`stages:${selectedId}`);
      setSamples(s || []);
      setStages(p || []);
    })();
  }, [selectedId]);
  const selectedProduct = products.find(p => p.id === selectedId) || null;
  const showDashboard = selectedId === null;

  // dashboard: pull every product's stage list to compute completion / delay status.
  // Only runs while the dashboard view is actually showing — navigating into a product costs nothing.
  useEffect(() => {
    if (!showDashboard || products.length === 0) return;
    let cancelled = false;
    (async () => {
      const result = {};
      for (const p of products) {
        const list = (await storageGet(`stages:${p.id}`)) || [];
        const total = list.length;
        const completed = list.filter(s => s.completed).length;
        const delayed = list.some(s => {
          if (s.completed) return false;
          const d = forecastDelay(s.id, list, {});
          const early = earliestAllowedStart(s, list);
          const conflict = early && early.date && s.plannedStart && toDate(s.plannedStart) < toDate(early.date);
          return d > 0 || conflict;
        });
        const currentStage = list.find(s => !s.completed);
        result[p.id] = {
          total,
          completed,
          delayed,
          currentStageName: currentStage ? currentStage.name || "（未命名流程）" : null
        };
      }
      if (!cancelled) setProductStats(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [showDashboard, products]);
  const persistProducts = async list => {
    setProducts(list);
    const ok = await storageSet("products", list);
    if (!ok) setSaveError("產品清單儲存失敗，請重試");
  };
  const persistSamples = async list => {
    setSamples(list);
    const ok = await storageSet(`samples:${selectedId}`, list);
    if (!ok) setSaveError("送樣資料儲存失敗，請重試");
  };
  const persistStages = async list => {
    setStages(list);
    const ok = await storageSet(`stages:${selectedId}`, list);
    if (!ok) setSaveError("流程資料儲存失敗，請重試");
  };
  const saveProduct = async data => {
    if (data.id) {
      persistProducts(products.map(p => p.id === data.id ? {
        ...p,
        ...data
      } : p));
    } else {
      const np = {
        ...data,
        id: uid()
      };
      await persistProducts([...products, np]);
      const savedTemplate = await storageGet("template:stages");
      await storageSet(`stages:${np.id}`, instantiateStages(savedTemplate || DEFAULT_STAGE_TEMPLATE));
      await storageSet(`samples:${np.id}`, []);
      setSelectedId(np.id);
      setTab("process");
    }
    setShowProductForm(false);
    setEditProduct(null);
  };
  const deleteProduct = id => {
    persistProducts(products.filter(p => p.id !== id));
    if (selectedId === id) setSelectedId(null);
  };
  const duplicateProduct = async source => {
    const newProduct = {
      id: uid(),
      name: (source.name || "未命名產品") + "（複製）",
      companyPN: "",
      oemPN: source.oemPN || "",
      kickoffDate: "",
      plannedEndDate: "",
      photo: source.photo || ""
    };
    await persistProducts([...products, newProduct]);

    // duplicate the process (stage) structure, remapping dependency ids to the new stage ids.
    // dates / completion / notes are NOT copied — they belong to the specific run, not the template.
    const sourceStages = source.id === selectedId ? stages : (await storageGet(`stages:${source.id}`)) || [];
    const idMap = {};
    const newStages = sourceStages.map(s => {
      const newId = uid();
      idMap[s.id] = newId;
      return {
        ...s,
        id: newId
      };
    }).map(s => ({
      ...s,
      dependsOn: (s.dependsOn || []).map(oldId => idMap[oldId]).filter(Boolean),
      completed: false,
      plannedStart: "",
      plannedEnd: "",
      actualStart: "",
      actualEnd: "",
      notes: []
    }));
    await storageSet(`stages:${newProduct.id}`, newStages);
    await storageSet(`samples:${newProduct.id}`, []); // sample records are batch-specific, not copied

    setSelectedId(newProduct.id);
    setTab("process");
  };
  const addSample = () => {
    persistSamples([...samples, {
      id: uid(),
      vendor: "",
      plannedDate: "",
      actualDate: "",
      result: "pending",
      failReason: "",
      note: ""
    }]);
  };
  const updateSample = (id, field, value) => {
    persistSamples(samples.map(s => s.id === id ? {
      ...s,
      [field]: value
    } : s));
  };
  const deleteSample = id => persistSamples(samples.filter(s => s.id !== id));
  const addStage = () => {
    persistStages([...stages, {
      id: uid(),
      name: "",
      unit: "",
      content: "",
      form: "",
      plannedStart: "",
      plannedEnd: "",
      actualStart: "",
      actualEnd: "",
      completed: false,
      dependsOn: [],
      notes: []
    }]);
  };
  const updateStage = (id, field, value) => {
    persistStages(stages.map(s => s.id === id ? {
      ...s,
      [field]: value
    } : s));
  };
  const addStageNote = (id, text) => {
    if (!text.trim()) return;
    persistStages(stages.map(s => s.id === id ? {
      ...s,
      notes: [...(s.notes || []), {
        id: uid(),
        text: text.trim(),
        time: new Date().toISOString(),
        editedAt: null
      }]
    } : s));
  };
  const editStageNote = (id, noteId, text) => {
    if (!text.trim()) return;
    persistStages(stages.map(s => s.id === id ? {
      ...s,
      notes: (s.notes || []).map(n => n.id === noteId ? {
        ...n,
        text: text.trim(),
        editedAt: new Date().toISOString()
      } : n)
    } : s));
  };
  const deleteStageNote = (id, noteId) => {
    persistStages(stages.map(s => s.id === id ? {
      ...s,
      notes: (s.notes || []).filter(n => n.id !== noteId)
    } : s));
  };
  const deleteStage = id => {
    const cleaned = stages.filter(s => s.id !== id).map(s => ({
      ...s,
      dependsOn: (s.dependsOn || []).filter(d => d !== id)
    }));
    persistStages(cleaned);
  };
  const moveStage = (id, direction) => {
    const idx = stages.findIndex(s => s.id === id);
    const targetIdx = idx + direction;
    if (idx === -1 || targetIdx < 0 || targetIdx >= stages.length) return;
    const next = [...stages];
    [next[idx], next[targetIdx]] = [next[targetIdx], next[idx]];
    persistStages(next);
  };

  // ---- default stage template CRUD (applies to future new products only) ----
  const persistTemplate = async list => {
    setTemplate(list);
    const ok = await storageSet("template:stages", list);
    if (!ok) setSaveError("範本儲存失敗，請重試");
  };
  const addTemplateItem = () => {
    persistTemplate([...template, {
      id: uid(),
      name: "",
      unit: "",
      form: "",
      dependsOn: []
    }]);
  };
  const updateTemplateItem = (id, field, value) => {
    persistTemplate(template.map(t => t.id === id ? {
      ...t,
      [field]: value
    } : t));
  };
  const deleteTemplateItem = id => {
    const cleaned = template.filter(t => t.id !== id).map(t => ({
      ...t,
      dependsOn: (t.dependsOn || []).filter(d => d !== id)
    }));
    persistTemplate(cleaned);
  };
  const moveTemplateItem = (id, direction) => {
    const idx = template.findIndex(t => t.id === id);
    const targetIdx = idx + direction;
    if (idx === -1 || targetIdx < 0 || targetIdx >= template.length) return;
    const next = [...template];
    [next[idx], next[targetIdx]] = [next[targetIdx], next[idx]];
    persistTemplate(next);
  };
  const ganttRange = useMemo(() => {
    const allDates = [];
    stages.forEach(s => {
      [s.plannedStart, s.plannedEnd, s.actualStart, s.actualEnd].forEach(d => {
        if (d) allDates.push(toDate(d).getTime());
      });
    });
    if (selectedProduct?.kickoffDate) allDates.push(toDate(selectedProduct.kickoffDate).getTime());
    if (selectedProduct?.plannedEndDate) allDates.push(toDate(selectedProduct.plannedEndDate).getTime());
    if (allDates.length === 0) {
      const now = Date.now();
      return {
        min: now,
        max: now + 30 * 86400000
      };
    }
    const min = Math.min(...allDates),
      max = Math.max(...allDates);
    const pad = Math.max((max - min) * 0.05, 86400000);
    return {
      min: min - pad,
      max: max + pad
    };
  }, [stages, selectedProduct]);
  const pct = dateStr => {
    if (!dateStr) return null;
    const t = toDate(dateStr).getTime();
    return (t - ganttRange.min) / (ganttRange.max - ganttRange.min) * 100;
  };
  const globalStyle = `
    @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap');
    button { background: none; border: none; padding: 0; margin: 0; font: inherit; color: inherit; cursor: pointer; text-decoration: none; }
    a { color: inherit; text-decoration: none; }
    input, select { font-family: inherit; color: inherit; }
    .mono { font-family: 'IBM Plex Mono', monospace; }
    .display { font-family: 'Space Grotesk', sans-serif; }
  `;
  if (loading) {
    return /*#__PURE__*/React.createElement("div", {
      style: {
        minHeight: 400,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: C.bg,
        color: C.muted,
        fontFamily: "Inter, 'PingFang TC', sans-serif"
      }
    }, /*#__PURE__*/React.createElement("style", null, globalStyle), "載入中…");
  }
  return /*#__PURE__*/React.createElement("div", {
    style: {
      minHeight: 700,
      background: C.bg,
      color: C.ink,
      fontFamily: "Inter, 'PingFang TC', sans-serif"
    }
  }, /*#__PURE__*/React.createElement("style", null, globalStyle), saveError && /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.red,
      color: "#fff",
      fontSize: 12,
      padding: "8px 16px",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement(AlertTriangle, {
    size: 14
  }), saveError), /*#__PURE__*/React.createElement("button", {
    onClick: () => setSaveError(""),
    style: {
      opacity: 0.8
    }
  }, /*#__PURE__*/React.createElement(X, {
    size: 14
  }))), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col md:flex-row",
    ref: containerRef
  }, /*#__PURE__*/React.createElement("div", {
    className: "w-full shrink-0",
    style: {
      width: isDesktop ? sidebarWidth : "100%",
      background: C.bg
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.sidebarBg,
      borderBottom: `1px solid ${C.border}`
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between px-4 py-4",
    style: {
      borderBottom: `1px solid ${C.border}`
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "display font-bold",
    style: {
      fontSize: 14,
      letterSpacing: 0.3,
      color: C.ink
    }
  }, "產品導入計劃"), /*#__PURE__*/React.createElement("div", {
    className: "mono truncate",
    style: {
      fontSize: 10,
      color: C.muted,
      maxWidth: 140
    }
  }, user?.email || "已登入")), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-1.5"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => signOut(auth),
    className: "flex items-center justify-center rounded-md",
    style: {
      width: 32,
      height: 32,
      background: "transparent",
      color: C.muted,
      border: `1px solid ${C.border}`
    },
    title: "登出"
  }, /*#__PURE__*/React.createElement(LogOut, {
    size: 14
  })), /*#__PURE__*/React.createElement("button", {
    onClick: () => setSelectedId(null),
    className: "flex items-center justify-center rounded-md",
    style: {
      width: 32,
      height: 32,
      background: showDashboard ? C.ink : "transparent",
      color: showDashboard ? "#fff" : C.muted,
      border: `1px solid ${showDashboard ? C.ink : C.border}`
    },
    title: "總覽儀表板"
  }, /*#__PURE__*/React.createElement(LayoutDashboard, {
    size: 15
  })), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setEditProduct(null);
      setShowProductForm(true);
    },
    className: "flex items-center justify-center rounded-md",
    style: {
      width: 32,
      height: 32,
      background: C.ink,
      color: "#fff"
    },
    title: "新增產品計劃"
  }, /*#__PURE__*/React.createElement(Plus, {
    size: 16
  })))), /*#__PURE__*/React.createElement("div", {
    className: "overflow-y-auto",
    style: {
      maxHeight: 620
    }
  }, products.length === 0 && /*#__PURE__*/React.createElement("div", {
    className: "text-center px-4 py-8",
    style: {
      fontSize: 12,
      color: C.muted
    }
  }, "尚無產品計劃", /*#__PURE__*/React.createElement("br", null), "點右上角「＋」新增"), products.map(p => /*#__PURE__*/React.createElement("button", {
    key: p.id,
    onClick: () => {
      setSelectedId(p.id);
      setTab("process");
    },
    className: "w-full flex items-center gap-3 px-4 py-1.5",
    style: {
      textAlign: "left",
      borderBottom: `1px solid ${C.borderLight}`,
      background: selectedId === p.id ? C.selectedBg : "transparent"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-center rounded shrink-0 overflow-hidden",
    style: {
      width: 42,
      height: 42,
      background: C.border
    }
  }, p.photo ? /*#__PURE__*/React.createElement("img", {
    src: p.photo,
    alt: "",
    className: "w-full h-full object-cover"
  }) : /*#__PURE__*/React.createElement(Package, {
    size: 18,
    color: C.muted
  })), /*#__PURE__*/React.createElement("div", {
    className: "min-w-0 flex-1"
  }, /*#__PURE__*/React.createElement("div", {
    className: "mono truncate",
    style: {
      fontSize: 13,
      fontWeight: 700,
      color: C.ink,
      lineHeight: 1.3
    }
  }, p.companyPN || "—"), /*#__PURE__*/React.createElement("div", {
    className: "truncate",
    style: {
      fontSize: 12,
      color: C.muted,
      lineHeight: 1.3
    }
  }, p.name || "未命名產品")), /*#__PURE__*/React.createElement(ChevronRight, {
    size: 14,
    color: C.mutedIcon,
    className: "shrink-0"
  })))))), isDesktop && /*#__PURE__*/React.createElement("div", {
    onMouseDown: startDrag,
    title: "拖曳調整寬度",
    className: "hidden md:block shrink-0",
    style: {
      width: 6,
      cursor: "col-resize",
      background: C.border
    }
  }), /*#__PURE__*/React.createElement("div", {
    className: "flex-1 min-w-0"
  }, !selectedProduct ? products.length === 0 ? /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-center",
    style: {
      minHeight: 500,
      color: C.muted,
      fontSize: 14
    }
  }, "請從左側選擇或新增一個產品計劃") : /*#__PURE__*/React.createElement(DashboardView, {
    products: products,
    stats: productStats,
    onSelect: id => {
      setSelectedId(id);
      setTab("process");
    }
  }) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "p-5",
    style: {
      background: C.panelBg,
      borderBottom: `1px solid ${C.border}`,
      position: "relative"
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setEditProduct(selectedProduct);
      setShowProductForm(true);
    },
    className: "flex items-center gap-1",
    style: {
      position: "absolute",
      top: 20,
      right: 20,
      fontSize: 12,
      color: C.muted
    }
  }, /*#__PURE__*/React.createElement(Pencil, {
    size: 12
  }), " 編輯"), /*#__PURE__*/React.createElement("div", {
    className: "flex items-start gap-4"
  }, /*#__PURE__*/React.createElement(ZoomableImage, {
    src: selectedProduct.photo,
    size: 80,
    alt: selectedProduct.name,
    rounded: 8
  }), /*#__PURE__*/React.createElement("div", {
    className: "shrink-0",
    style: {
      maxWidth: 320
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "display font-bold truncate mb-2",
    style: {
      fontSize: 18
    }
  }, selectedProduct.name || "未命名產品"), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap",
    style: {
      columnGap: 32,
      rowGap: 8
    }
  }, /*#__PURE__*/React.createElement(Field, {
    label: "公司產品編號",
    value: selectedProduct.companyPN
  }), /*#__PURE__*/React.createElement(Field, {
    label: "原廠編號",
    value: selectedProduct.oemPN
  }), /*#__PURE__*/React.createElement(Field, {
    label: "正式開案日期",
    value: selectedProduct.kickoffDate,
    mono: true
  }), /*#__PURE__*/React.createElement(Field, {
    label: "預計結案日",
    value: selectedProduct.plannedEndDate,
    mono: true
  }))), /*#__PURE__*/React.createElement("div", {
    className: "flex-1 min-w-0 hidden md:block",
    style: {
      paddingRight: 72
    }
  }, /*#__PURE__*/React.createElement(HeaderGantt, {
    stages: stages
  })))), /*#__PURE__*/React.createElement("div", {
    className: "flex px-5",
    style: {
      background: C.panelBg,
      borderBottom: `1px solid ${C.border}`
    }
  }, [{
    k: "process",
    label: "產品流程"
  }, {
    k: "samples",
    label: "產品送樣資訊"
  }, {
    k: "template",
    label: "預設流程範本"
  }].map(t => /*#__PURE__*/React.createElement("button", {
    key: t.k,
    onClick: () => setTab(t.k),
    className: "px-4 py-3",
    style: {
      fontSize: 14,
      fontWeight: 500,
      borderBottom: `2px solid ${tab === t.k ? C.ink : "transparent"}`,
      color: tab === t.k ? C.ink : C.muted
    }
  }, t.label))), /*#__PURE__*/React.createElement("div", {
    className: "p-5"
  }, tab === "samples" && /*#__PURE__*/React.createElement(SamplesPanel, {
    samples: samples,
    onAdd: addSample,
    onUpdate: updateSample,
    onDelete: deleteSample
  }), tab === "process" && /*#__PURE__*/React.createElement(ProcessPanel, {
    stages: stages,
    onAdd: addStage,
    onUpdate: updateStage,
    onDelete: deleteStage,
    onReorder: moveStage,
    onAddNote: addStageNote,
    onEditNote: editStageNote,
    onDeleteNote: deleteStageNote,
    pct: pct
  }), tab === "template" && /*#__PURE__*/React.createElement(TemplateEditor, {
    template: template,
    onAdd: addTemplateItem,
    onUpdate: updateTemplateItem,
    onDelete: deleteTemplateItem,
    onReorder: moveTemplateItem
  }))))), showProductForm && /*#__PURE__*/React.createElement(ProductForm, {
    initial: editProduct,
    onCancel: () => {
      setShowProductForm(false);
      setEditProduct(null);
    },
    onSave: saveProduct,
    onDelete: editProduct ? () => setConfirmDeleteProduct(editProduct) : null,
    onDuplicate: editProduct ? () => {
      duplicateProduct(editProduct);
      setShowProductForm(false);
      setEditProduct(null);
    } : null
  }), confirmDeleteProduct && /*#__PURE__*/React.createElement(ConfirmModal, {
    title: "刪除產品計劃",
    message: `確定要刪除「${confirmDeleteProduct.name || "未命名產品"}」嗎？清單會移除，但送樣/流程的舊資料鍵不會自動清除（僅個人儲存空間中殘留，不影響其他計劃）。`,
    confirmLabel: "確定刪除",
    danger: true,
    onConfirm: () => {
      deleteProduct(confirmDeleteProduct.id);
      setConfirmDeleteProduct(null);
      setShowProductForm(false);
      setEditProduct(null);
    },
    onCancel: () => setConfirmDeleteProduct(null)
  }));
}
function stageStatus(s) {
  const today = todayISO();
  if (s.completed) return "done";
  if (s.plannedEnd && s.plannedEnd < today && !s.actualEnd) return "overdue";
  if (s.actualStart) return "inprogress";
  return "notstarted";
}
const STATUS_META = {
  done: {
    color: "#2F6F6B",
    label: "已完成"
  },
  overdue: {
    color: "#C1443C",
    label: "逾期未完成"
  },
  inprogress: {
    color: "#C98A2E",
    label: "進行中"
  },
  notstarted: {
    color: "#D9DBD5",
    label: "尚未開始"
  }
};
function DashboardView({
  products,
  stats,
  onSelect
}) {
  const overallDelayed = products.filter(p => stats[p.id]?.delayed).length;
  return /*#__PURE__*/React.createElement("div", {
    className: "p-6"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between mb-1"
  }, /*#__PURE__*/React.createElement("div", {
    className: "display font-bold",
    style: {
      fontSize: 20
    }
  }, "總覽儀表板")), /*#__PURE__*/React.createElement("div", {
    className: "mono mb-5",
    style: {
      fontSize: 12,
      color: "#8A9099"
    }
  }, products.length, " 個計畫", overallDelayed > 0 && /*#__PURE__*/React.createElement("span", {
    style: {
      color: "#C1443C"
    }
  }, " · ", overallDelayed, " 個有流程落後")), /*#__PURE__*/React.createElement("div", {
    style: {
      border: "1px solid #E3E4E0",
      borderRadius: 10,
      background: "#fff",
      overflow: "hidden"
    }
  }, products.map((p, i) => {
    const st = stats[p.id];
    const total = st?.total ?? 0;
    const completed = st?.completed ?? 0;
    const pctDone = total > 0 ? Math.round(completed / total * 100) : 0;
    const delayed = st?.delayed;
    const currentStageName = st?.currentStageName;
    const daysLeft = p.plannedEndDate ? Math.round((toDate(p.plannedEndDate) - toDate(todayISO())) / 86400000) : null;
    return /*#__PURE__*/React.createElement("button", {
      key: p.id,
      onClick: () => onSelect(p.id),
      className: "w-full flex items-center gap-4 px-4 py-3",
      style: {
        textAlign: "left",
        borderTop: i === 0 ? "none" : "1px solid #F0F1EC",
        background: "#fff"
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-2.5 shrink-0",
      style: {
        width: 190
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center justify-center rounded shrink-0 overflow-hidden",
      style: {
        width: 36,
        height: 36,
        background: "#F0F1EC"
      }
    }, p.photo ? /*#__PURE__*/React.createElement("img", {
      src: p.photo,
      alt: "",
      className: "w-full h-full object-cover"
    }) : /*#__PURE__*/React.createElement(Package, {
      size: 15,
      color: "#B4B7AF"
    })), /*#__PURE__*/React.createElement("div", {
      className: "min-w-0 flex-1"
    }, /*#__PURE__*/React.createElement("div", {
      className: "truncate",
      style: {
        fontSize: 13,
        fontWeight: 700,
        color: "#1B2430"
      }
    }, p.name || "未命名產品"), /*#__PURE__*/React.createElement("div", {
      className: "mono truncate",
      style: {
        fontSize: 10,
        color: "#8A9099"
      }
    }, p.companyPN || "—"))), /*#__PURE__*/React.createElement("div", {
      className: "flex-1 min-w-0"
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        height: 7,
        background: "#F0F1EC",
        borderRadius: 4,
        overflow: "hidden"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        height: "100%",
        width: `${pctDone}%`,
        background: delayed ? "#C1443C" : pctDone === 100 ? "#2F6F6B" : "#1B2430"
      }
    })), total > 0 && /*#__PURE__*/React.createElement("div", {
      className: "truncate mt-1",
      style: {
        fontSize: 11,
        color: currentStageName ? "#5B6169" : "#2F6F6B"
      }
    }, currentStageName ? `目前階段：${currentStageName}` : "已全部完成")), /*#__PURE__*/React.createElement("div", {
      className: "mono text-right shrink-0",
      style: {
        width: 70,
        fontSize: 12,
        color: "#8A9099"
      }
    }, completed, "/", total, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        color: "#1B2430",
        fontWeight: 600
      }
    }, pctDone, "%")), /*#__PURE__*/React.createElement("div", {
      className: "shrink-0",
      style: {
        width: 56
      }
    }, delayed && /*#__PURE__*/React.createElement("span", {
      className: "flex items-center gap-0.5 px-1.5 py-0.5 justify-center",
      style: {
        fontSize: 10,
        color: "#C1443C",
        background: "#FBEDEC",
        borderRadius: 4
      }
    }, /*#__PURE__*/React.createElement(AlertTriangle, {
      size: 10
    }), "落後")), /*#__PURE__*/React.createElement("div", {
      className: "text-right shrink-0",
      style: {
        width: 110,
        fontSize: 11,
        color: daysLeft !== null && daysLeft < 0 ? "#C1443C" : "#8A9099"
      }
    }, daysLeft !== null ? daysLeft < 0 ? `已超過 ${Math.abs(daysLeft)} 天` : `剩 ${daysLeft} 天` : "—"));
  })));
}
function HeaderGantt({
  stages
}) {
  if (!stages || stages.length === 0) {
    return /*#__PURE__*/React.createElement("div", {
      className: "flex items-center justify-center",
      style: {
        height: 60,
        border: "1px dashed #E3E4E0",
        borderRadius: 8,
        fontSize: 11,
        color: "#B4B7AF"
      }
    }, "尚無流程可顯示");
  }
  const doneCount = stages.filter(s => s.completed).length;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      border: "1px solid #E3E4E0",
      borderRadius: 8,
      background: "#FAFAF8",
      padding: "10px 12px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between mb-2 flex-wrap",
    style: {
      rowGap: 4
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "uppercase tracking-wide",
    style: {
      fontSize: 9,
      color: "#8A9099"
    }
  }, "流程進度總覽"), /*#__PURE__*/React.createElement("span", {
    className: "mono",
    style: {
      fontSize: 11,
      color: "#5B6169"
    }
  }, doneCount, " / ", stages.length, " 完成")), /*#__PURE__*/React.createElement("div", {
    className: "flex",
    style: {
      gap: 2,
      height: 22
    }
  }, stages.map((s, i) => {
    const status = stageStatus(s);
    const meta = STATUS_META[status];
    const title = `${i + 1}. ${s.name || "未命名流程"} — ${meta.label}\n預計：${s.plannedStart || "—"} ~ ${s.plannedEnd || "—"}\n實際：${s.actualStart || "—"} ~ ${s.actualEnd || "—"}`;
    return /*#__PURE__*/React.createElement("div", {
      key: s.id,
      title: title,
      style: {
        flex: 1,
        minWidth: 4,
        background: meta.color,
        borderRadius: 3,
        cursor: "default"
      }
    });
  })), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-3 flex-wrap mt-2",
    style: {
      fontSize: 10,
      color: "#8A9099"
    }
  }, Object.entries(STATUS_META).map(([k, m]) => /*#__PURE__*/React.createElement("span", {
    key: k,
    className: "flex items-center gap-1"
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-block",
      width: 8,
      height: 8,
      borderRadius: 2,
      background: m.color
    }
  }), m.label))));
}
function ZoomableImage({
  src,
  size = 64,
  alt = "",
  rounded = 6
}) {
  const [zoomed, setZoomed] = useState(false);
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("button", {
    onClick: () => src && setZoomed(true),
    className: "flex items-center justify-center shrink-0 overflow-hidden",
    style: {
      width: size,
      height: size,
      background: "#F0F1EC",
      border: "1px solid #E3E4E0",
      borderRadius: rounded,
      cursor: src ? "zoom-in" : "default"
    },
    title: src ? "點擊放大檢視" : ""
  }, src ? /*#__PURE__*/React.createElement("img", {
    src: src,
    alt: alt,
    className: "w-full h-full object-cover"
  }) : /*#__PURE__*/React.createElement(Package, {
    size: Math.round(size * 0.3),
    color: "#B4B7AF"
  })), zoomed && src && /*#__PURE__*/React.createElement("div", {
    onClick: () => setZoomed(false),
    className: "flex items-center justify-center p-6",
    style: {
      position: "fixed",
      inset: 0,
      background: "rgba(0,0,0,0.75)",
      zIndex: 80,
      cursor: "zoom-out"
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: src,
    alt: alt,
    style: {
      maxWidth: "90vw",
      maxHeight: "85vh",
      borderRadius: 8,
      boxShadow: "0 12px 40px rgba(0,0,0,0.4)"
    }
  }), /*#__PURE__*/React.createElement("button", {
    onClick: () => setZoomed(false),
    style: {
      position: "absolute",
      top: 20,
      right: 24,
      color: "#fff"
    }
  }, /*#__PURE__*/React.createElement(X, {
    size: 26
  }))));
}
function ConfirmModal({
  title,
  message,
  confirmLabel = "確定",
  danger,
  onConfirm,
  onCancel
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-center p-4",
    style: {
      position: "fixed",
      inset: 0,
      background: "rgba(0,0,0,0.45)",
      zIndex: 70
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "w-full p-5",
    style: {
      maxWidth: 360,
      background: "#fff",
      borderRadius: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "display font-bold mb-2",
    style: {
      fontSize: 15
    }
  }, title), /*#__PURE__*/React.createElement("div", {
    className: "mb-5",
    style: {
      fontSize: 13,
      color: "#5B6169",
      lineHeight: 1.5
    }
  }, message), /*#__PURE__*/React.createElement("div", {
    className: "flex justify-end gap-2"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onCancel,
    className: "px-4 py-2",
    style: {
      fontSize: 14,
      color: "#5B6169",
      border: "1px solid #D9DBD5",
      borderRadius: 6
    }
  }, "取消"), /*#__PURE__*/React.createElement("button", {
    onClick: onConfirm,
    className: "px-4 py-2",
    style: {
      fontSize: 14,
      color: "#fff",
      background: danger ? "#C1443C" : "#1B2430",
      borderRadius: 6
    }
  }, confirmLabel))));
}
function Field({
  label,
  value,
  mono
}) {
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "uppercase tracking-wide",
    style: {
      fontSize: 11,
      color: "#8A9099"
    }
  }, label), /*#__PURE__*/React.createElement("div", {
    className: mono ? "mono" : "",
    style: {
      fontSize: 16,
      fontWeight: 500
    }
  }, fmt(value)));
}
function ProductForm({
  initial,
  onCancel,
  onSave,
  onDelete,
  onDuplicate
}) {
  const [name, setName] = useState(initial?.name || "");
  const [companyPN, setCompanyPN] = useState(initial?.companyPN || "");
  const [oemPN, setOemPN] = useState(initial?.oemPN || "");
  const [kickoffDate, setKickoffDate] = useState(initial?.kickoffDate || "");
  const [plannedEndDate, setPlannedEndDate] = useState(initial?.plannedEndDate || "");
  const [photo, setPhoto] = useState(initial?.photo || "");
  const [photoError, setPhotoError] = useState("");
  const [uploading, setUploading] = useState(false);
  const handleFile = e => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      setPhotoError("圖片請控制在 8MB 以內");
      return;
    }
    setPhotoError("");
    setUploading(true);
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const path = `product-photos/${uid()}-${file.name}`;
        const storageRef = ref(storage, path);
        await uploadString(storageRef, reader.result, "data_url");
        const url = await getDownloadURL(storageRef);
        setPhoto(url);
      } catch (err) {
        console.error("photo upload failed:", err);
        setPhotoError("照片上傳失敗，請確認 Firebase Storage 是否已啟用，或重試一次");
      } finally {
        setUploading(false);
      }
    };
    reader.onerror = () => {
      setUploading(false);
      setPhotoError("讀取檔案失敗，請重試");
    };
    reader.readAsDataURL(file);
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-center p-4",
    style: {
      position: "fixed",
      inset: 0,
      background: "rgba(0,0,0,0.4)",
      zIndex: 50
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "w-full p-5 overflow-y-auto",
    style: {
      maxWidth: 420,
      maxHeight: "90vh",
      background: "#fff",
      borderRadius: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between mb-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "display font-bold",
    style: {
      fontSize: 16
    }
  }, initial ? "編輯產品計劃" : "新增產品計劃"), /*#__PURE__*/React.createElement("button", {
    onClick: onCancel
  }, /*#__PURE__*/React.createElement(X, {
    size: 18,
    color: "#8A9099"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "space-y-3"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-4"
  }, /*#__PURE__*/React.createElement(ZoomableImage, {
    src: photo,
    size: 96,
    alt: "產品照片"
  }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "flex items-center gap-1 px-3 py-1.5",
    style: {
      fontSize: 12,
      color: "#5B6169",
      border: "1px solid #D9DBD5",
      borderRadius: 6,
      cursor: uploading ? "default" : "pointer",
      opacity: uploading ? 0.6 : 1
    }
  }, /*#__PURE__*/React.createElement(Upload, {
    size: 12
  }), " ", uploading ? "上傳中…" : "上傳照片", /*#__PURE__*/React.createElement("input", {
    type: "file",
    accept: "image/*",
    className: "hidden",
    onChange: handleFile,
    disabled: uploading
  })), photo && !uploading && /*#__PURE__*/React.createElement("div", {
    className: "mt-1",
    style: {
      fontSize: 10,
      color: "#8A9099"
    }
  }, "點縮圖可放大檢視"))), photoError && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: "#C1443C"
    }
  }, photoError), /*#__PURE__*/React.createElement(LabeledInput, {
    label: "產品名稱",
    value: name,
    onChange: setName,
    placeholder: "例如：XX 感測器模組"
  }), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 gap-3"
  }, /*#__PURE__*/React.createElement(LabeledInput, {
    label: "公司產品編號",
    value: companyPN,
    onChange: setCompanyPN
  }), /*#__PURE__*/React.createElement(LabeledInput, {
    label: "原廠編號",
    value: oemPN,
    onChange: setOemPN
  })), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 gap-3"
  }, /*#__PURE__*/React.createElement(LabeledInput, {
    label: "正式開案日期",
    type: "date",
    value: kickoffDate,
    onChange: setKickoffDate
  }), /*#__PURE__*/React.createElement(LabeledInput, {
    label: "預計結案日",
    type: "date",
    value: plannedEndDate,
    onChange: setPlannedEndDate
  }))), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between mt-5"
  }, onDelete ? /*#__PURE__*/React.createElement("button", {
    onClick: onDelete,
    className: "flex items-center gap-1",
    style: {
      fontSize: 12,
      color: "#C1443C"
    }
  }, /*#__PURE__*/React.createElement(Trash2, {
    size: 13
  }), " 刪除此計劃") : /*#__PURE__*/React.createElement("span", null), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2"
  }, onDuplicate && /*#__PURE__*/React.createElement("button", {
    onClick: onDuplicate,
    className: "flex items-center gap-1 px-3 py-2",
    style: {
      fontSize: 13,
      color: "#5B6169",
      border: "1px solid #D9DBD5",
      borderRadius: 6
    },
    title: "複製此計劃的流程結構，另存為新案"
  }, /*#__PURE__*/React.createElement(Copy, {
    size: 13
  }), " 複製另存新案"), /*#__PURE__*/React.createElement("button", {
    onClick: onCancel,
    className: "px-4 py-2",
    style: {
      fontSize: 14,
      color: "#5B6169",
      border: "1px solid #D9DBD5",
      borderRadius: 6
    }
  }, "取消"), /*#__PURE__*/React.createElement("button", {
    onClick: () => onSave({
      id: initial?.id,
      name,
      companyPN,
      oemPN,
      kickoffDate,
      plannedEndDate,
      photo
    }),
    disabled: uploading,
    className: "px-4 py-2",
    style: {
      fontSize: 14,
      color: "#fff",
      background: "#1B2430",
      borderRadius: 6,
      opacity: uploading ? 0.6 : 1
    }
  }, uploading ? "照片上傳中…" : "儲存")))));
}
function LabeledInput({
  label,
  value,
  onChange,
  type = "text",
  placeholder
}) {
  return /*#__PURE__*/React.createElement("label", {
    className: "block"
  }, /*#__PURE__*/React.createElement("div", {
    className: "uppercase tracking-wide mb-1",
    style: {
      fontSize: 10,
      color: "#8A9099"
    }
  }, label), /*#__PURE__*/React.createElement("input", {
    type: type,
    value: value,
    placeholder: placeholder,
    onChange: e => onChange(e.target.value),
    className: type === "date" ? "mono w-full" : "w-full",
    style: {
      border: "1px solid #D9DBD5",
      borderRadius: 6,
      padding: "6px 10px",
      fontSize: 14,
      outline: "none"
    }
  }));
}
function SamplesPanel({
  samples,
  onAdd,
  onUpdate,
  onDelete
}) {
  const cols = "1fr 1.1fr 1.1fr 80px 100px 1.3fr 1fr 28px";
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between mb-3"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      fontWeight: 600
    }
  }, "送樣紀錄"), /*#__PURE__*/React.createElement("button", {
    onClick: onAdd,
    className: "flex items-center gap-1 px-3 py-1.5",
    style: {
      fontSize: 12,
      color: "#fff",
      background: "#1B2430",
      borderRadius: 6
    }
  }, /*#__PURE__*/React.createElement(Plus, {
    size: 13
  }), " 新增送樣")), samples.length === 0 ? /*#__PURE__*/React.createElement(EmptyState, {
    text: "尚無送樣紀錄，點「新增送樣」開始記錄。"
  }) : /*#__PURE__*/React.createElement("div", {
    style: {
      border: "1px solid #E3E4E0",
      borderRadius: 8,
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "grid uppercase tracking-wide px-3 py-2",
    style: {
      gridTemplateColumns: cols,
      background: "#F0F1EC",
      fontSize: 10,
      color: "#8A9099",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("div", null, "廠商"), /*#__PURE__*/React.createElement("div", null, "預計交樣日"), /*#__PURE__*/React.createElement("div", null, "實際交樣日"), /*#__PURE__*/React.createElement("div", null, "誤差"), /*#__PURE__*/React.createElement("div", null, "檢驗結果"), /*#__PURE__*/React.createElement("div", null, "不合格原因"), /*#__PURE__*/React.createElement("div", null, "備註"), /*#__PURE__*/React.createElement("div", null)), samples.map((s, i) => /*#__PURE__*/React.createElement("div", {
    key: s.id,
    className: "grid items-center px-3 py-2",
    style: {
      gridTemplateColumns: cols,
      gap: 8,
      background: i % 2 ? "#fff" : "#FAFAF8",
      borderTop: "1px solid #E3E4E0"
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "text",
    value: s.vendor || "",
    placeholder: "廠商名稱",
    onChange: e => onUpdate(s.id, "vendor", e.target.value),
    style: inputSm
  }), /*#__PURE__*/React.createElement("input", {
    type: "date",
    value: s.plannedDate,
    onChange: e => onUpdate(s.id, "plannedDate", e.target.value),
    className: "mono",
    style: inputSm
  }), /*#__PURE__*/React.createElement("input", {
    type: "date",
    value: s.actualDate,
    onChange: e => onUpdate(s.id, "actualDate", e.target.value),
    className: "mono",
    style: inputSm
  }), /*#__PURE__*/React.createElement(DiffBadge, {
    diff: daysDiff(s.plannedDate, s.actualDate)
  }), /*#__PURE__*/React.createElement("select", {
    value: s.result,
    onChange: e => onUpdate(s.id, "result", e.target.value),
    style: {
      ...inputSm,
      color: s.result === "pass" ? "#2F6F6B" : s.result === "fail" ? "#C1443C" : "#8A9099",
      borderColor: s.result === "pass" ? "#2F6F6B" : s.result === "fail" ? "#C1443C" : "#D9DBD5",
      background: s.result === "pass" ? "#EAF3F2" : s.result === "fail" ? "#FBEDEC" : "#fff"
    }
  }, /*#__PURE__*/React.createElement("option", {
    value: "pending"
  }, "待檢驗"), /*#__PURE__*/React.createElement("option", {
    value: "pass"
  }, "合格"), /*#__PURE__*/React.createElement("option", {
    value: "fail"
  }, "不合格")), /*#__PURE__*/React.createElement("input", {
    type: "text",
    value: s.failReason || "",
    disabled: s.result !== "fail",
    placeholder: s.result === "fail" ? "填寫不合格原因" : "—",
    onChange: e => onUpdate(s.id, "failReason", e.target.value),
    style: {
      ...inputSm,
      borderColor: s.result === "fail" ? "#C1443C" : "#E3E4E0",
      background: s.result === "fail" ? "#fff" : "#F4F5F2",
      color: s.result === "fail" ? "#1B2430" : "#B4B7AF"
    }
  }), /*#__PURE__*/React.createElement("input", {
    type: "text",
    value: s.note,
    placeholder: "備註",
    onChange: e => onUpdate(s.id, "note", e.target.value),
    style: inputSm
  }), /*#__PURE__*/React.createElement("button", {
    onClick: () => onDelete(s.id),
    className: "flex justify-center",
    style: {
      color: "#B4B7AF"
    }
  }, /*#__PURE__*/React.createElement(Trash2, {
    size: 14
  }))))));
}
const inputSm = {
  border: "1px solid #D9DBD5",
  borderRadius: 6,
  padding: "4px 8px",
  fontSize: 12,
  width: "100%"
};
function TemplateEditor({
  template,
  onAdd,
  onUpdate,
  onDelete,
  onReorder
}) {
  const [depModalId, setDepModalId] = useState(null);
  const depModalItem = template.find(t => t.id === depModalId) || null;
  const toggleDep = (itemId, targetId) => {
    const item = template.find(t => t.id === itemId);
    const cur = item.dependsOn || [];
    const next = cur.includes(targetId) ? cur.filter(d => d !== targetId) : [...cur, targetId];
    onUpdate(itemId, "dependsOn", next);
  };
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "mb-3"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      fontWeight: 600
    }
  }, "預設流程範本"), /*#__PURE__*/React.createElement("div", {
    className: "mt-1",
    style: {
      fontSize: 11,
      color: "#8A9099"
    }
  }, "之後「新增產品計劃」時，會自動帶入這裡設定的流程清單當起點。修改這裡不會影響已經建立好的產品——那些產品的流程要改，請到各自的「產品流程」分頁調整。")), /*#__PURE__*/React.createElement("div", {
    className: "flex justify-end mb-3"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onAdd,
    className: "flex items-center gap-1 px-3 py-1.5",
    style: {
      fontSize: 12,
      color: "#fff",
      background: "#1B2430",
      borderRadius: 6
    }
  }, /*#__PURE__*/React.createElement(Plus, {
    size: 13
  }), " 新增範本項目")), template.length === 0 ? /*#__PURE__*/React.createElement(EmptyState, {
    text: "範本是空的，新增產品計劃時就不會自動帶入任何流程。點「新增範本項目」開始建立。"
  }) : /*#__PURE__*/React.createElement("div", {
    style: {
      border: "1px solid #E3E4E0",
      borderRadius: 8,
      overflow: "auto",
      maxWidth: "100%"
    }
  }, /*#__PURE__*/React.createElement("table", {
    style: {
      borderCollapse: "collapse",
      width: "100%",
      minWidth: 640,
      fontSize: 12
    }
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", {
    style: {
      background: "#F0F1EC",
      position: "sticky",
      top: 0,
      zIndex: 1
    }
  }, ["#", "流程名稱", "負責單位", "產出文件", "相依前置", ""].map((h, i) => /*#__PURE__*/React.createElement("th", {
    key: i,
    className: "uppercase tracking-wide",
    style: {
      ...thStyle,
      textAlign: i === 0 ? "center" : "left"
    }
  }, h)))), /*#__PURE__*/React.createElement("tbody", null, template.map((t, i) => {
    const deps = (t.dependsOn || []).map(id => template.find(x => x.id === id)).filter(Boolean);
    return /*#__PURE__*/React.createElement("tr", {
      key: t.id,
      style: {
        background: i % 2 ? "#fff" : "#FAFAF8",
        borderTop: "1px solid #E3E4E0"
      }
    }, /*#__PURE__*/React.createElement("td", {
      style: {
        ...tdStyle,
        textAlign: "center"
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center justify-center gap-1"
    }, /*#__PURE__*/React.createElement("span", {
      className: "mono",
      style: {
        fontSize: 12,
        color: "#8A9099",
        minWidth: 14,
        textAlign: "right"
      }
    }, i + 1), /*#__PURE__*/React.createElement("div", {
      className: "flex flex-col"
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => onReorder(t.id, -1),
      disabled: i === 0,
      style: {
        color: i === 0 ? "#E3E4E0" : "#8A9099",
        lineHeight: 0
      }
    }, /*#__PURE__*/React.createElement(ChevronUp, {
      size: 11
    })), /*#__PURE__*/React.createElement("button", {
      onClick: () => onReorder(t.id, 1),
      disabled: i === template.length - 1,
      style: {
        color: i === template.length - 1 ? "#E3E4E0" : "#8A9099",
        lineHeight: 0
      }
    }, /*#__PURE__*/React.createElement(ChevronDown, {
      size: 11
    }))))), /*#__PURE__*/React.createElement("td", {
      style: {
        ...tdStyle,
        minWidth: 160
      }
    }, /*#__PURE__*/React.createElement("input", {
      value: t.name,
      placeholder: "流程名稱",
      onChange: e => onUpdate(t.id, "name", e.target.value),
      style: cellInput
    })), /*#__PURE__*/React.createElement("td", {
      style: {
        ...tdStyle,
        minWidth: 100
      }
    }, /*#__PURE__*/React.createElement("input", {
      value: t.unit,
      placeholder: "負責單位",
      onChange: e => onUpdate(t.id, "unit", e.target.value),
      style: cellInput
    })), /*#__PURE__*/React.createElement("td", {
      style: {
        ...tdStyle,
        minWidth: 160
      }
    }, /*#__PURE__*/React.createElement("input", {
      value: t.form,
      placeholder: "產出文件",
      onChange: e => onUpdate(t.id, "form", e.target.value),
      style: cellInput
    })), /*#__PURE__*/React.createElement("td", {
      style: {
        ...tdStyle,
        minWidth: 100
      }
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => setDepModalId(t.id),
      className: "flex items-center gap-1 px-2 py-1",
      style: {
        fontSize: 11,
        border: "1px dashed #D9DBD5",
        borderRadius: 6,
        color: deps.length ? "#1B2430" : "#8A9099",
        width: "100%"
      }
    }, /*#__PURE__*/React.createElement(Link2, {
      size: 11
    }), " ", deps.length ? `${deps.length} 項` : "設定")), /*#__PURE__*/React.createElement("td", {
      style: {
        ...tdStyle,
        textAlign: "center"
      }
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => onDelete(t.id),
      style: {
        color: "#B4B7AF"
      }
    }, /*#__PURE__*/React.createElement(Trash2, {
      size: 14
    }))));
  })))), depModalItem && /*#__PURE__*/React.createElement(DependencyModal, {
    stage: depModalItem,
    allStages: template,
    onToggle: targetId => toggleDep(depModalItem.id, targetId),
    onClose: () => setDepModalId(null)
  }));
}
function ProcessPanel({
  stages,
  onAdd,
  onUpdate,
  onDelete,
  onReorder,
  onAddNote,
  onEditNote,
  onDeleteNote,
  pct
}) {
  const [depModalId, setDepModalId] = useState(null);
  const [dateModalId, setDateModalId] = useState(null);
  const [noteModalId, setNoteModalId] = useState(null);
  const depModalStage = stages.find(s => s.id === depModalId) || null;
  const dateModalStage = stages.find(s => s.id === dateModalId) || null;
  const noteModalStage = stages.find(s => s.id === noteModalId) || null;
  const toggleDep = (stageId, targetId) => {
    const stage = stages.find(s => s.id === stageId);
    const cur = stage.dependsOn || [];
    const next = cur.includes(targetId) ? cur.filter(d => d !== targetId) : [...cur, targetId];
    onUpdate(stageId, "dependsOn", next);
  };
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between mb-3"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      fontWeight: 600
    }
  }, "流程管理"), /*#__PURE__*/React.createElement("button", {
    onClick: onAdd,
    className: "flex items-center gap-1 px-3 py-1.5",
    style: {
      fontSize: 12,
      color: "#fff",
      background: "#1B2430",
      borderRadius: 6
    }
  }, /*#__PURE__*/React.createElement(Plus, {
    size: 13
  }), " 新增流程")), stages.length === 0 ? /*#__PURE__*/React.createElement(EmptyState, {
    text: "尚無流程項目，點「新增流程」建立第一個階段。"
  }) : /*#__PURE__*/React.createElement("div", {
    style: {
      border: "1px solid #E3E4E0",
      borderRadius: 8,
      overflow: "auto",
      maxWidth: "100%"
    }
  }, /*#__PURE__*/React.createElement("table", {
    style: {
      borderCollapse: "collapse",
      width: "100%",
      minWidth: 960,
      fontSize: 12
    }
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", {
    style: {
      background: "#F0F1EC",
      position: "sticky",
      top: 0,
      zIndex: 1
    }
  }, ["#", "完成", "流程名稱", "負責單位", "工作內容", "產出文件", "相依前置", "時程", "備註", ""].map((h, i) => /*#__PURE__*/React.createElement("th", {
    key: i,
    className: "uppercase tracking-wide",
    style: {
      ...thStyle,
      textAlign: i <= 1 ? "center" : "left"
    }
  }, h)))), /*#__PURE__*/React.createElement("tbody", null, stages.map((s, i) => {
    const deps = (s.dependsOn || []).map(id => stages.find(x => x.id === id)).filter(Boolean);
    const early = earliestAllowedStart(s, stages);
    const conflict = early && early.date && s.plannedStart && toDate(s.plannedStart) < toDate(early.date);
    const endDiff = daysDiff(s.plannedEnd, s.actualEnd);
    const delay = forecastDelay(s.id, stages, {});
    const rowBg = i % 2 ? "#fff" : "#FAFAF8";
    const hasAnyDate = s.plannedStart || s.plannedEnd || s.actualStart || s.actualEnd;
    return /*#__PURE__*/React.createElement("tr", {
      key: s.id,
      style: {
        background: rowBg,
        borderTop: "1px solid #E3E4E0",
        opacity: s.completed ? 0.42 : 1,
        transition: "opacity 0.15s"
      }
    }, /*#__PURE__*/React.createElement("td", {
      style: {
        ...tdStyle,
        textAlign: "center"
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center justify-center gap-1"
    }, /*#__PURE__*/React.createElement("span", {
      className: "mono",
      style: {
        fontSize: 12,
        color: "#8A9099",
        minWidth: 14,
        textAlign: "right"
      }
    }, i + 1), /*#__PURE__*/React.createElement("div", {
      className: "flex flex-col"
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => onReorder(s.id, -1),
      disabled: i === 0,
      style: {
        color: i === 0 ? "#E3E4E0" : "#8A9099",
        lineHeight: 0
      }
    }, /*#__PURE__*/React.createElement(ChevronUp, {
      size: 11
    })), /*#__PURE__*/React.createElement("button", {
      onClick: () => onReorder(s.id, 1),
      disabled: i === stages.length - 1,
      style: {
        color: i === stages.length - 1 ? "#E3E4E0" : "#8A9099",
        lineHeight: 0
      }
    }, /*#__PURE__*/React.createElement(ChevronDown, {
      size: 11
    }))))), /*#__PURE__*/React.createElement("td", {
      style: {
        ...tdStyle,
        textAlign: "center"
      }
    }, /*#__PURE__*/React.createElement("input", {
      type: "checkbox",
      checked: !!s.completed,
      onChange: () => onUpdate(s.id, "completed", !s.completed),
      style: {
        width: 15,
        height: 15
      }
    })), /*#__PURE__*/React.createElement("td", {
      style: {
        ...tdStyle,
        minWidth: 130
      }
    }, /*#__PURE__*/React.createElement("input", {
      value: s.name,
      placeholder: "流程名稱",
      onChange: e => onUpdate(s.id, "name", e.target.value),
      style: {
        ...cellInput,
        textDecoration: s.completed ? "line-through" : "none"
      }
    })), /*#__PURE__*/React.createElement("td", {
      style: {
        ...tdStyle,
        minWidth: 90
      }
    }, /*#__PURE__*/React.createElement("input", {
      value: s.unit,
      placeholder: "負責單位",
      onChange: e => onUpdate(s.id, "unit", e.target.value),
      style: cellInput
    })), /*#__PURE__*/React.createElement("td", {
      style: {
        ...tdStyle,
        minWidth: 160
      }
    }, /*#__PURE__*/React.createElement("input", {
      value: s.content,
      placeholder: "工作內容",
      onChange: e => onUpdate(s.id, "content", e.target.value),
      style: cellInput
    })), /*#__PURE__*/React.createElement("td", {
      style: {
        ...tdStyle,
        minWidth: 120
      }
    }, /*#__PURE__*/React.createElement("input", {
      value: s.form,
      placeholder: "產出文件",
      onChange: e => onUpdate(s.id, "form", e.target.value),
      style: cellInput
    })), /*#__PURE__*/React.createElement("td", {
      style: {
        ...tdStyle,
        minWidth: 90
      }
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => setDepModalId(s.id),
      className: "flex items-center gap-1 px-2 py-1",
      style: {
        fontSize: 11,
        border: "1px dashed #D9DBD5",
        borderRadius: 6,
        color: deps.length ? "#1B2430" : "#8A9099",
        width: "100%"
      }
    }, /*#__PURE__*/React.createElement(Link2, {
      size: 11
    }), " ", deps.length ? `${deps.length} 項` : "設定")), /*#__PURE__*/React.createElement("td", {
      style: {
        ...tdStyle,
        minWidth: 130
      }
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => setDateModalId(s.id),
      className: "w-full",
      style: {
        textAlign: "left",
        padding: "4px 8px",
        border: `1px solid ${conflict ? "#C1443C" : "#D9DBD5"}`,
        borderRadius: 6,
        background: conflict ? "#FFF9F8" : "#fff"
      }
    }, hasAnyDate ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      className: "mono",
      style: {
        fontSize: 10,
        color: "#8A9099"
      }
    }, "預 ", shortDate(s.plannedStart), "–", shortDate(s.plannedEnd)), /*#__PURE__*/React.createElement("div", {
      className: "mono flex items-center gap-1",
      style: {
        fontSize: 10,
        color: endDiff > 0 ? "#C1443C" : endDiff < 0 ? "#2F6F6B" : "#5B6169"
      }
    }, "實 ", shortDate(s.actualStart), "–", shortDate(s.actualEnd), endDiff !== null && (endDiff > 0 ? ` +${endDiff}` : endDiff < 0 ? ` ${endDiff}` : " ✓"))) : /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-1",
      style: {
        fontSize: 11,
        color: "#8A9099"
      }
    }, /*#__PURE__*/React.createElement(CalendarDays, {
      size: 11
    }), " 設定時程"), (conflict || delay > 0) && /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-1",
      style: {
        fontSize: 10,
        color: "#C1443C"
      }
    }, /*#__PURE__*/React.createElement(AlertTriangle, {
      size: 10
    }), " ", conflict ? "時程衝突" : `預估延後${delay}天`))), /*#__PURE__*/React.createElement("td", {
      style: {
        ...tdStyle,
        minWidth: 110
      }
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => setNoteModalId(s.id),
      className: "w-full",
      style: {
        textAlign: "left",
        padding: "4px 8px",
        border: "1px dashed #D9DBD5",
        borderRadius: 6,
        background: "#fff"
      }
    }, (s.notes || []).length > 0 ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-1",
      style: {
        fontSize: 11,
        color: "#1B2430"
      }
    }, /*#__PURE__*/React.createElement(MessageSquare, {
      size: 11
    }), " ", s.notes.length, " 則"), /*#__PURE__*/React.createElement("div", {
      className: "truncate",
      style: {
        fontSize: 10,
        color: "#8A9099"
      }
    }, s.notes[s.notes.length - 1].text)) : /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-1",
      style: {
        fontSize: 11,
        color: "#8A9099"
      }
    }, /*#__PURE__*/React.createElement(MessageSquare, {
      size: 11
    }), " 新增備註"))), /*#__PURE__*/React.createElement("td", {
      style: {
        ...tdStyle,
        textAlign: "center"
      }
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => onDelete(s.id),
      style: {
        color: "#B4B7AF"
      }
    }, /*#__PURE__*/React.createElement(Trash2, {
      size: 14
    }))));
  })))), depModalStage && /*#__PURE__*/React.createElement(DependencyModal, {
    stage: depModalStage,
    allStages: stages,
    onToggle: targetId => toggleDep(depModalStage.id, targetId),
    onClose: () => setDepModalId(null)
  }), dateModalStage && /*#__PURE__*/React.createElement(DateModal, {
    stage: dateModalStage,
    allStages: stages,
    onUpdate: onUpdate,
    onClose: () => setDateModalId(null)
  }), noteModalStage && /*#__PURE__*/React.createElement(NotesModal, {
    stage: noteModalStage,
    onAdd: text => onAddNote(noteModalStage.id, text),
    onEdit: (noteId, text) => onEditNote(noteModalStage.id, noteId, text),
    onDelete: noteId => onDeleteNote(noteModalStage.id, noteId),
    onClose: () => setNoteModalId(null)
  }));
}
function shortDate(s) {
  if (!s) return "–";
  const d = toDate(s);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function DateModal({
  stage,
  allStages,
  onUpdate,
  onClose
}) {
  const plannedDur = durationDays(stage.plannedStart, stage.plannedEnd);
  const actualDur = durationDays(stage.actualStart, stage.actualEnd);
  const startDiff = daysDiff(stage.plannedStart, stage.actualStart);
  const endDiff = daysDiff(stage.plannedEnd, stage.actualEnd);
  const early = earliestAllowedStart(stage, allStages);
  const conflict = early && early.date && stage.plannedStart && toDate(stage.plannedStart) < toDate(early.date);
  const waitingOnDep = early && early.partial;
  const delay = forecastDelay(stage.id, allStages, {});
  return /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-center p-4",
    style: {
      position: "fixed",
      inset: 0,
      background: "rgba(0,0,0,0.4)",
      zIndex: 60
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "w-full p-5",
    style: {
      maxWidth: 380,
      maxHeight: "85vh",
      overflowY: "auto",
      background: "#fff",
      borderRadius: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between mb-3"
  }, /*#__PURE__*/React.createElement("div", {
    className: "display font-bold",
    style: {
      fontSize: 15
    }
  }, stage.name || "未命名流程", " · 時程"), /*#__PURE__*/React.createElement("button", {
    onClick: onClose
  }, /*#__PURE__*/React.createElement(X, {
    size: 18,
    color: "#8A9099"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 gap-3"
  }, /*#__PURE__*/React.createElement(LabeledInput, {
    label: "預計起始日",
    type: "date",
    value: stage.plannedStart,
    onChange: v => onUpdate(stage.id, "plannedStart", v)
  }), /*#__PURE__*/React.createElement(LabeledInput, {
    label: "預計完成日",
    type: "date",
    value: stage.plannedEnd,
    onChange: v => onUpdate(stage.id, "plannedEnd", v)
  }), /*#__PURE__*/React.createElement(LabeledInput, {
    label: "實際起始日",
    type: "date",
    value: stage.actualStart,
    onChange: v => onUpdate(stage.id, "actualStart", v)
  }), /*#__PURE__*/React.createElement(LabeledInput, {
    label: "實際完成日",
    type: "date",
    value: stage.actualEnd,
    onChange: v => onUpdate(stage.id, "actualEnd", v)
  })), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap items-center gap-x-4 gap-y-1 pt-3 mt-3",
    style: {
      fontSize: 12,
      borderTop: "1px solid #EDEEEA"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "#8A9099"
    }
  }, "預計天數：", /*#__PURE__*/React.createElement("span", {
    className: "mono"
  }, plannedDur ?? "—")), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "#8A9099"
    }
  }, "實際天數：", /*#__PURE__*/React.createElement("span", {
    className: "mono"
  }, actualDur ?? "—")), /*#__PURE__*/React.createElement("span", {
    className: "flex items-center gap-1",
    style: {
      color: "#8A9099"
    }
  }, "起始誤差：", /*#__PURE__*/React.createElement(DiffBadge, {
    diff: startDiff
  })), /*#__PURE__*/React.createElement("span", {
    className: "flex items-center gap-1",
    style: {
      color: "#8A9099"
    }
  }, "完成誤差：", /*#__PURE__*/React.createElement(DiffBadge, {
    diff: endDiff
  }))), waitingOnDep && /*#__PURE__*/React.createElement("div", {
    className: "mt-2",
    style: {
      fontSize: 11,
      color: "#8A9099"
    }
  }, "前置流程尚未填日期，無法計算最早可開始日"), !waitingOnDep && early?.date && /*#__PURE__*/React.createElement("div", {
    className: "mt-2",
    style: {
      fontSize: 11,
      color: conflict ? "#C1443C" : "#8A9099"
    }
  }, "依前置流程推算，最早可開始日：", /*#__PURE__*/React.createElement("span", {
    className: "mono"
  }, early.date), conflict && "　— 目前預計起始日早於此，時程衝突"), delay > 0 && /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-1 mt-2",
    style: {
      color: "#C1443C",
      fontWeight: 600,
      fontSize: 12
    }
  }, /*#__PURE__*/React.createElement(AlertTriangle, {
    size: 12
  }), " 累積預估延後 ", delay, " 天"), /*#__PURE__*/React.createElement("div", {
    className: "flex justify-end mt-4"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onClose,
    className: "px-4 py-2",
    style: {
      fontSize: 14,
      color: "#fff",
      background: "#1B2430",
      borderRadius: 6
    }
  }, "完成"))));
}
const thStyle = {
  padding: "8px 10px",
  fontSize: 10,
  color: "#8A9099",
  whiteSpace: "nowrap"
};
const tdStyle = {
  padding: "6px 8px",
  verticalAlign: "middle"
};
const cellInput = {
  border: "1px solid #D9DBD5",
  borderRadius: 5,
  padding: "4px 6px",
  fontSize: 12,
  width: "100%"
};
function DependencyModal({
  stage,
  allStages,
  onToggle,
  onClose
}) {
  const descendants = getDescendants(stage.id, allStages);
  const availableDeps = allStages.filter(s => s.id !== stage.id && !descendants.has(s.id));
  const excludedDeps = allStages.filter(s => s.id !== stage.id && descendants.has(s.id));
  const current = stage.dependsOn || [];
  return /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-center p-4",
    style: {
      position: "fixed",
      inset: 0,
      background: "rgba(0,0,0,0.4)",
      zIndex: 60
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "w-full p-5",
    style: {
      maxWidth: 380,
      maxHeight: "80vh",
      overflowY: "auto",
      background: "#fff",
      borderRadius: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between mb-1"
  }, /*#__PURE__*/React.createElement("div", {
    className: "display font-bold",
    style: {
      fontSize: 15
    }
  }, "設定相依前置流程"), /*#__PURE__*/React.createElement("button", {
    onClick: onClose
  }, /*#__PURE__*/React.createElement(X, {
    size: 18,
    color: "#8A9099"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "mb-3",
    style: {
      fontSize: 12,
      color: "#8A9099"
    }
  }, "「", stage.name || "未命名流程", "」需要等哪些流程先完成？"), availableDeps.length === 0 ? /*#__PURE__*/React.createElement("div", {
    className: "py-4 text-center",
    style: {
      fontSize: 12,
      color: "#8A9099"
    }
  }, "沒有其他流程可設定") : /*#__PURE__*/React.createElement("div", {
    className: "space-y-1"
  }, availableDeps.map(d => /*#__PURE__*/React.createElement("label", {
    key: d.id,
    className: "flex items-center gap-2 px-2 py-1.5",
    style: {
      fontSize: 13,
      border: "1px solid #E3E4E0",
      borderRadius: 6,
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: current.includes(d.id),
    onChange: () => onToggle(d.id),
    style: {
      width: 14,
      height: 14
    }
  }), d.name || "未命名流程"))), excludedDeps.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "mt-3",
    style: {
      fontSize: 10,
      color: "#8A9099"
    }
  }, "未列出：", excludedDeps.map(d => d.name || "未命名流程").join("、"), "（會形成循環相依，系統已排除）"), /*#__PURE__*/React.createElement("div", {
    className: "flex justify-end mt-4"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onClose,
    className: "px-4 py-2",
    style: {
      fontSize: 14,
      color: "#fff",
      background: "#1B2430",
      borderRadius: 6
    }
  }, "完成"))));
}
function EmptyState({
  text
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "text-center py-8",
    style: {
      border: "1px dashed #D9DBD5",
      borderRadius: 8,
      fontSize: 12,
      color: "#8A9099"
    }
  }, text);
}
const pad2 = n => String(n).padStart(2, "0");
function formatDT(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
const COLLAPSE_THRESHOLD = 4; // beyond this many notes, list auto-collapses to recent ones

function NotesModal({
  stage,
  onAdd,
  onEdit,
  onDelete,
  onClose
}) {
  const [draft, setDraft] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState("");
  const notes = [...(stage.notes || [])].sort((a, b) => new Date(b.time) - new Date(a.time));
  const isLong = notes.length > COLLAPSE_THRESHOLD;
  const visible = isLong && !showAll ? notes.slice(0, COLLAPSE_THRESHOLD) : notes;
  const submit = () => {
    if (!draft.trim()) return;
    onAdd(draft);
    setDraft("");
  };
  const startEdit = n => {
    setEditingId(n.id);
    setEditDraft(n.text);
  };
  const saveEdit = () => {
    if (!editDraft.trim()) return;
    onEdit(editingId, editDraft);
    setEditingId(null);
    setEditDraft("");
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-center p-4",
    style: {
      position: "fixed",
      inset: 0,
      background: "rgba(0,0,0,0.4)",
      zIndex: 60
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "w-full p-5",
    style: {
      maxWidth: 420,
      maxHeight: "85vh",
      display: "flex",
      flexDirection: "column",
      background: "#fff",
      borderRadius: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between mb-3 shrink-0"
  }, /*#__PURE__*/React.createElement("div", {
    className: "display font-bold",
    style: {
      fontSize: 15
    }
  }, stage.name || "未命名流程", " · 備註"), /*#__PURE__*/React.createElement("button", {
    onClick: onClose
  }, /*#__PURE__*/React.createElement(X, {
    size: 18,
    color: "#8A9099"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "flex gap-2 mb-3 shrink-0"
  }, /*#__PURE__*/React.createElement("textarea", {
    value: draft,
    onChange: e => setDraft(e.target.value),
    placeholder: "輸入備註，送出時會自動記錄時間",
    rows: 2,
    style: {
      flex: 1,
      border: "1px solid #D9DBD5",
      borderRadius: 6,
      padding: "6px 8px",
      fontSize: 13,
      resize: "vertical",
      fontFamily: "inherit"
    }
  }), /*#__PURE__*/React.createElement("button", {
    onClick: submit,
    className: "shrink-0 px-3",
    style: {
      fontSize: 12,
      color: "#fff",
      background: "#1B2430",
      borderRadius: 6
    }
  }, "新增")), /*#__PURE__*/React.createElement("div", {
    className: "overflow-y-auto",
    style: {
      flex: 1
    }
  }, notes.length === 0 ? /*#__PURE__*/React.createElement("div", {
    className: "text-center py-6",
    style: {
      fontSize: 12,
      color: "#8A9099"
    }
  }, "尚無備註") : /*#__PURE__*/React.createElement("div", {
    className: "space-y-2"
  }, visible.map(n => /*#__PURE__*/React.createElement("div", {
    key: n.id,
    className: "p-2",
    style: {
      border: "1px solid #E3E4E0",
      borderRadius: 6,
      background: "#FAFAF8"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between mb-1"
  }, /*#__PURE__*/React.createElement("span", {
    className: "mono",
    style: {
      fontSize: 10,
      color: "#8A9099"
    }
  }, formatDT(n.time), n.editedAt && /*#__PURE__*/React.createElement("span", {
    style: {
      color: "#B4B7AF"
    }
  }, " · 已編輯 ", formatDT(n.editedAt))), editingId !== n.id && /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => startEdit(n),
    style: {
      color: "#8A9099"
    }
  }, /*#__PURE__*/React.createElement(Pencil, {
    size: 12
  })), /*#__PURE__*/React.createElement("button", {
    onClick: () => onDelete(n.id),
    style: {
      color: "#B4B7AF"
    }
  }, /*#__PURE__*/React.createElement(Trash2, {
    size: 12
  })))), editingId === n.id ? /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("textarea", {
    value: editDraft,
    onChange: e => setEditDraft(e.target.value),
    rows: 2,
    autoFocus: true,
    style: {
      width: "100%",
      border: "1px solid #D9DBD5",
      borderRadius: 6,
      padding: "6px 8px",
      fontSize: 13,
      resize: "vertical",
      fontFamily: "inherit"
    }
  }), /*#__PURE__*/React.createElement("div", {
    className: "flex justify-end gap-2 mt-1"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setEditingId(null);
      setEditDraft("");
    },
    style: {
      fontSize: 11,
      color: "#8A9099"
    }
  }, "取消"), /*#__PURE__*/React.createElement("button", {
    onClick: saveEdit,
    className: "px-2 py-1",
    style: {
      fontSize: 11,
      color: "#fff",
      background: "#1B2430",
      borderRadius: 5
    }
  }, "儲存"))) : /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      whiteSpace: "pre-wrap"
    }
  }, n.text)))), isLong && /*#__PURE__*/React.createElement("button", {
    onClick: () => setShowAll(v => !v),
    className: "w-full text-center mt-2 py-1.5",
    style: {
      fontSize: 12,
      color: "#5B6169",
      border: "1px dashed #D9DBD5",
      borderRadius: 6
    }
  }, showAll ? "收合" : `顯示全部 ${notes.length} 則`)), /*#__PURE__*/React.createElement("div", {
    className: "flex justify-end mt-4 shrink-0"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onClose,
    className: "px-4 py-2",
    style: {
      fontSize: 14,
      color: "#fff",
      background: "#1B2430",
      borderRadius: 6
    }
  }, "關閉"))));
}

// ---------- Login screen ----------
function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const handleSubmit = async () => {
    setError("");
    if (!email.trim() || !password) {
      setError("請輸入帳號與密碼");
      return;
    }
    setBusy(true);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
    } catch (e) {
      setError("登入失敗，請確認帳號密碼是否正確");
    } finally {
      setBusy(false);
    }
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-center p-4",
    style: {
      minHeight: "100vh",
      background: "#F4F5F2",
      fontFamily: "Inter, 'PingFang TC', sans-serif"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "w-full p-6",
    style: {
      maxWidth: 360,
      background: "#fff",
      border: "1px solid #E3E4E0",
      borderRadius: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "font-bold mb-1",
    style: {
      fontSize: 18,
      color: "#1B2430"
    }
  }, "產品導入計劃"), /*#__PURE__*/React.createElement("div", {
    className: "mb-5",
    style: {
      fontSize: 12,
      color: "#8A9099"
    }
  }, "請登入以繼續"), /*#__PURE__*/React.createElement("div", {
    className: "space-y-3"
  }, /*#__PURE__*/React.createElement("label", {
    className: "block"
  }, /*#__PURE__*/React.createElement("div", {
    className: "mb-1",
    style: {
      fontSize: 11,
      color: "#8A9099"
    }
  }, "帳號 (Email)"), /*#__PURE__*/React.createElement("input", {
    type: "email",
    value: email,
    onChange: e => setEmail(e.target.value),
    onKeyDown: e => e.key === "Enter" && handleSubmit(),
    style: {
      width: "100%",
      border: "1px solid #D9DBD5",
      borderRadius: 6,
      padding: "8px 10px",
      fontSize: 14
    }
  })), /*#__PURE__*/React.createElement("label", {
    className: "block"
  }, /*#__PURE__*/React.createElement("div", {
    className: "mb-1",
    style: {
      fontSize: 11,
      color: "#8A9099"
    }
  }, "密碼"), /*#__PURE__*/React.createElement("input", {
    type: "password",
    value: password,
    onChange: e => setPassword(e.target.value),
    onKeyDown: e => e.key === "Enter" && handleSubmit(),
    style: {
      width: "100%",
      border: "1px solid #D9DBD5",
      borderRadius: 6,
      padding: "8px 10px",
      fontSize: 14
    }
  }))), error && /*#__PURE__*/React.createElement("div", {
    className: "mt-3",
    style: {
      fontSize: 12,
      color: "#C1443C"
    }
  }, error), /*#__PURE__*/React.createElement("button", {
    onClick: handleSubmit,
    disabled: busy,
    className: "w-full mt-5 py-2.5",
    style: {
      fontSize: 14,
      color: "#fff",
      background: "#1B2430",
      borderRadius: 6,
      opacity: busy ? 0.6 : 1
    }
  }, busy ? "登入中…" : "登入"), /*#__PURE__*/React.createElement("div", {
    className: "mt-4",
    style: {
      fontSize: 11,
      color: "#B4B7AF"
    }
  }, "帳號只由管理者在 Firebase 後台建立，這裡沒有開放註冊。")));
}

// ---------- Auth gate: decides whether to show the login screen or the app ----------
export default function AuthGate() {
  const [user, setUser] = useState(undefined); // undefined = still checking, null = logged out

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, u => setUser(u));
    return () => unsubscribe();
  }, []);
  if (user === undefined) {
    return /*#__PURE__*/React.createElement("div", {
      className: "flex items-center justify-center",
      style: {
        minHeight: "100vh",
        background: "#F4F5F2",
        color: "#8A9099",
        fontFamily: "Inter, sans-serif"
      }
    }, "驗證登入狀態…");
  }
  if (!user) {
    return /*#__PURE__*/React.createElement(LoginScreen, null);
  }
  return /*#__PURE__*/React.createElement(NPITracker, {
    user: user
  });
}

// ---------- mount ----------
import { createRoot } from "react-dom/client";
const rootEl = document.getElementById("root");
createRoot(rootEl).render(/*#__PURE__*/React.createElement(AuthGate, null));