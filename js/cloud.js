// Historial en la nube (Firebase: Authentication con Google + Firestore).
// El SDK se carga solo si la configuración trae `firebase` (Administración → Nube o config.json).
//
// Colecciones:
//   members/{email}              { role: 'admin' | 'seller', name }  — quién puede entrar
//   quotes/{número}              lo que ve todo el equipo (cliente, piezas, precios, estado, PO)
//   quotes/{número}/private/costs  costos y ganancia — solo admin
// Las reglas de seguridad están en firestore.rules.

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
let fb = null;      // módulos del SDK
let app = null, auth = null, db = null;
let member = null;  // { email, name, role } o null

export const isReady = () => !!db;
export const currentMember = () => member;
export const isAdmin = () => member?.role === 'admin';

export async function initCloud(config, onChange) {
  if (!config?.apiKey || !config?.projectId) return false;
  if (!fb) {
    const [a, au, fs] = await Promise.all([
      import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-auth.js`), import(`${SDK}/firebase-firestore.js`),
    ]);
    fb = { ...a, ...au, ...fs };
  }
  app = fb.initializeApp(config);
  auth = fb.getAuth(app);
  db = fb.getFirestore(app);
  fb.onAuthStateChanged(auth, async (u) => {
    member = null;
    let error = null;
    if (u) {
      try {
        const snap = await fb.getDoc(fb.doc(db, 'members', u.email.toLowerCase()));
        if (snap.exists()) member = { email: u.email.toLowerCase(), name: snap.data().name || u.displayName || u.email, role: snap.data().role || 'seller' };
        else error = 'notMember';
      } catch (e) { error = 'notMember'; console.warn(e); }
    }
    onChange({ user: u ? { email: u.email, name: u.displayName } : null, member, error });
  });
  return true;
}

export async function signIn() {
  await fb.signInWithPopup(auth, new fb.GoogleAuthProvider());
}
export async function signOutCloud() { await fb.signOut(auth); }

/**
 * Guarda una cotización. Si el número ya existe (otro equipo lo usó el mismo día), pide uno
 * nuevo con `nextNumber()` y vuelve a intentar.
 * @returns el número con el que quedó guardada
 */
export async function saveQuote(build, nextNumber) {
  if (!member) throw new Error('Inicia sesión para guardar');
  let number = build.number;
  for (let i = 0; i < 6; i++) {
    const ref = fb.doc(db, 'quotes', number);
    const { pub, priv } = build.make(number);
    const ok = await fb.runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists()) return false;
      tx.set(ref, { ...pub, createdAt: fb.serverTimestamp() });
      tx.set(fb.doc(db, 'quotes', number, 'private', 'costs'), priv);
      return true;
    });
    if (ok) return number;
    number = nextNumber();
  }
  throw new Error('No se pudo reservar un número de cotización');
}

export async function listQuotes(month) {
  const snap = await fb.getDocs(fb.query(fb.collection(db, 'quotes'), fb.where('month', '==', month)));
  const rows = snap.docs.map((d) => d.data());
  rows.sort((a, b) => (b.number > a.number ? 1 : -1));
  let privs = null;
  if (isAdmin()) {
    privs = {};
    await Promise.all(rows.map(async (r) => {
      const p = await fb.getDoc(fb.doc(db, 'quotes', r.number, 'private', 'costs'));
      if (p.exists()) privs[r.number] = p.data();
    }));
  }
  return { rows, privs };
}

// Cambia el estado de una cotización: 'po' (con precio final y fecha), 'lost' o 'quoted'.
export async function setStatus(number, status, { finalPrice = null, poDate = null, notes } = {}) {
  const patch = {
    status,
    finalPrice: status === 'po' ? finalPrice : null,
    poDate: status === 'po' ? poDate : null,
    updatedAt: fb.serverTimestamp(),
    updatedBy: member.email,
  };
  if (notes != null) patch.notes = notes;
  await fb.updateDoc(fb.doc(db, 'quotes', number), patch);
}
