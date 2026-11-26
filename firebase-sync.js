// Firebase client configuration. Access is controlled by the published Firestore rules.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js';
import { getFirestore, collection, doc, onSnapshot, writeBatch } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js';
const config={apiKey:'AIzaSyBoFewJ3UJfN_D2GB1fm85iDHuVwn0Lc5A',authDomain:'quran-hifz-dac55.firebaseapp.com',projectId:'quran-hifz-dac55',storageBucket:'quran-hifz-dac55.firebasestorage.app',messagingSenderId:'445922532747',appId:'1:445922532747:web:9c30f22bc925af3793638e'};
const copy=x=>JSON.parse(JSON.stringify(x));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const id=()=>globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random()}`;
const keyFor=(kind,key)=>`${kind}_${encodeURIComponent(key)}`;
// One document per mistake/revision/day/position, not one document per user.
export function records(s){
  const result=new Map();
  const put=(kind,key,value)=>result.set(keyFor(kind,key),{kind,key:String(key),value:copy(value)});
  for(const m of s.marks||[])if(m.id)put('mark',m.id,m);
  for(const r of s.revisions||[])if(r.id)put('revision',r.id,r);
  for(const [k,v] of Object.entries(s.days||{}))if(v)put('day',k,true);
  for(const [k,v] of Object.entries(s.positions||{}))if(Number(v)>0)put('position',k,Number(v));
  put('current','last',{juz:Number(s.juz)||1,page:Number(s.page)||1});
  return result;
}
export function fromRecords(base,map){
  const s={...base,marks:[],revisions:[],days:{},positions:{}};
  for(const r of map.values()){
    if(!r||typeof r.key!=='string')continue;
    const v=r.value;
    if(r.kind==='mark'&&v?.id)s.marks.push(v);
    if(r.kind==='revision'&&v?.id)s.revisions.push(v);
    if(r.kind==='day'&&/^\d{4}-\d{2}-\d{2}$/.test(r.key))s.days[r.key]=true;
    if(r.kind==='position'&&/^(?:[1-9]|[12]\d|30)$/.test(r.key)&&Number(v)>0)s.positions[r.key]=Number(v);
    if(r.kind==='current'&&v){s.juz=Number(v.juz)||1;s.page=Number(v.page)||1;}
  }
  const byTime=(a,b)=>String(a.time||'').localeCompare(String(b.time||''))||String(a.id).localeCompare(String(b.id));
  s.marks.sort(byTime);s.revisions.sort(byTime);
  return s;
}
export function changes(before,after){
  const out=[];
  for(const [k,v] of after)if(!same(before.get(k),v))out.push({key:k,value:v,token:id()});
  for(const k of before.keys())if(!after.has(k))out.push({key:k,value:null,token:id()});
  return out;
}
export function overlay(remote,pending){const m=new Map(remote);for(const p of pending){if(p.value===null)m.delete(p.key);else m.set(p.key,p.value)}return m;}
const meaningful=s=>!!(s.marks?.length||s.revisions?.length||Object.keys(s.days||{}).length||Object.keys(s.positions||{}).some(k=>Number(k)!==1||s.positions[k]>1));
const cacheKey=uid=>`my-hifz-cloud-v1:${uid}`;
function load(uid){try{const x=JSON.parse(localStorage.getItem(cacheKey(uid))||'null');return x&&Array.isArray(x.pending)?x:null}catch{return null}}
function mergePending(old,added){const m=new Map(old.map(x=>[x.key,x]));for(const x of added)m.set(x.key,x);return [...m.values()]}
export function startCloud(app){
  const $=x=>document.getElementById(x), auth=getAuth(initializeApp(config)), db=getFirestore();
  const provider=new GoogleAuthProvider();provider.setCustomParameters({prompt:'select_account'});
  let active=null,initialized=false,authBusy=false;
  function status(message,level='warn'){
    $('cloudStatus').textContent=message;
    $('accountBtn').dataset.cloud=level;
    $('accountBtn').textContent=active?(level==='ok'?'Account ✓':'Account !'):'Sign in';
    $('librarySyncLabel').textContent=active?(level==='ok'?'Cloud synced':'Cloud sync pending'):'Saved on this device';
  }
  function controls(){
    $('googleSignIn').hidden=!!active;$('googleSignIn').disabled=!initialized||authBusy;
    $('googleSignOut').hidden=!active;$('googleSignOut').disabled=authBusy;
    $('importGuest').hidden=!active||!meaningful(app.guest());$('importGuest').disabled=!active?.ready;
    $('retryCloud').hidden=!active;
    $('cloudIdentity').textContent=active?active.user.email||active.user.displayName||'Signed in':'Guest · not signed in';
  }
  function updateStatus(s){
    if(active!==s)return;
    controls();
    if(s.error){status(s.error);return;}
    if(s.pending.length||s.sending){status('Saved on this device · waiting for cloud sync ('+s.pending.length+' pending).');return;}
    if(!s.ready||!s.online){status('Waiting for cloud connection. You can keep reading and saving on this device.');return;}
    status('All records synced to your Google account.','ok');
  }
  function errorText(e){
    const code=e?.code||'';
    if(code.includes('permission-denied'))return 'Cloud access denied. Check the published Firestore rules, then tap Retry sync.';
    if(code.includes('unauthorized-domain'))return 'Google sign-in is not authorised for this website domain.';
    if(code.includes('operation-not-allowed'))return 'Google sign-in is not enabled in Firebase Authentication.';
    if(code.includes('popup-blocked'))return 'Your browser blocked Google sign-in. Allow pop-ups and try again.';
    if(code.includes('popup-closed'))return 'Sign-in cancelled. Try again when ready.';
    return 'Cloud connection failed: '+(e?.message||'unknown error');
  }
  function store(s,state,pending){
    // State and its outbox are committed together to the browser before any upload.
    localStorage.setItem(cacheKey(s.user.uid),JSON.stringify({state,pending}));
  }
  function persist(s,state,added=[]){
    const disk=load(s.user.uid);
    const next=mergePending(disk?.pending||s.pending,added);
    store(s,state,next);s.pending=next;
  }
  function saveState(s,state){
    if(active!==s)throw Error('Account changed');
    const next=records(state),diff=changes(s.baseline,next);
    try{persist(s,state,diff)}catch(e){s.error='Device storage is full or blocked. Download a backup; changes may not survive a reload.';updateStatus(s);throw e}
    s.baseline=next;updateStatus(s);flush(s);
  }
  async function flush(s){
    if(active!==s||s.sending||!s.ready||s.error)return;
    // Read the durable queue again to include pending changes left by another tab.
    s.pending=load(s.user.uid)?.pending||s.pending;
    if(!s.pending.length){updateStatus(s);return;}
    s.sending=true;updateStatus(s);
    const batchItems=s.pending.slice(0,400);
    try{
      const batch=writeBatch(db);
      for(const p of batchItems){const ref=doc(s.col,p.key);if(p.value===null)batch.delete(ref);else batch.set(ref,p.value);}
      await batch.commit(); // resolves only once acknowledged by Firestore
      if(active!==s)return;
      const ack=new Set(batchItems.map(p=>p.token));
      const pending=(load(s.user.uid)?.pending||s.pending).filter(p=>!ack.has(p.token));
      store(s,app.get(),pending);s.pending=pending;
    }catch(e){if(active===s)s.error=errorText(e);}
    finally{ s.sending=false;if(active===s){updateStatus(s);if(!s.error&&s.pending.length)queueMicrotask(()=>flush(s));}}
  }
  function listen(s){
    if(s.stop)s.stop();
    s.stop=onSnapshot(s.col,{includeMetadataChanges:true},snap=>{
      if(active!==s)return;
      s.online=!snap.metadata.fromCache;
      // Memory cache may be empty on the first connection. Never erase the device cache from it.
      if(snap.metadata.fromCache){updateStatus(s);return;}
      const remote=new Map(snap.docs.map(d=>[d.id,d.data()]));
      s.pending=load(s.user.uid)?.pending||s.pending;
      const combined=overlay(remote,s.pending);
      const first=!s.ready;s.ready=true;s.remote=remote;
      // Keep the current page stable during ordinary live updates. On first server load,
      // follow the saved cloud position unless the reader has already moved locally.
      const state=fromRecords(app.get(),combined);
      const follow=first&&!s.pending.some(p=>p.key===keyFor('current','last'));
      try{
        const applied=app.apply(state,{followPosition:follow});
        s.baseline=records(applied);persist(s,applied);
      }catch(e){s.error='Could not cache the synced records on this device. Download a backup.';}
      updateStatus(s);flush(s);
    },e=>{if(active===s){s.online=false;s.error=errorText(e);updateStatus(s);}});
  }
  function switchUser(user){
    if(active?.user.uid===user?.uid&&active)return;
    if(active?.stop)active.stop();active=null;app.setSession(null);
    if(!user){app.apply(app.guest(),{switching:true});status('Sign in to sync your Quran records.','idle');controls();return;}
    const cached=load(user.uid),base=cached?.state||app.fresh();
    const s={user,col:collection(db,'users',user.uid,'records'),pending:cached?.pending||[],ready:false,online:false,sending:false,error:null,stop:null,remote:new Map()};
    active=s;const applied=app.apply(base,{switching:true});s.baseline=records(applied);
    app.setSession({save:state=>saveState(s,state)});controls();updateStatus(s);listen(s);
  }
  onAuthStateChanged(auth,user=>{initialized=true;authBusy=false;switchUser(user);controls();},e=>{initialized=true;authBusy=false;status(errorText(e));controls();});
  $('googleSignIn').onclick=async()=>{if(authBusy)return;authBusy=true;controls();status('Opening Google sign-in…');try{await signInWithPopup(auth,provider)}catch(e){status(errorText(e));}finally{authBusy=false;controls();}};
  $('googleSignOut').onclick=async()=>{if(!active||authBusy)return;if(active.pending.length&&!confirm('Some changes have not synced yet. They will remain on this device for this account. Sign out anyway?'))return;authBusy=true;controls();try{await signOut(auth)}catch(e){status(errorText(e));}finally{authBusy=false;controls();}};
  $('retryCloud').onclick=()=>{const s=active;if(!s)return;s.error=null;listen(s);updateStatus(s);flush(s);};
  $('importGuest').onclick=()=>{
    const s=active;if(!s?.ready)return;
    if(!confirm('Import the existing guest mistakes and revisions on this device into '+(s.user.email||'this account')+'? Existing account records with the same ID will be kept.'))return;
    const guest=records(app.guest()),current=records(app.get());
    for(const [k,v] of guest)if(!current.has(k)&&v.kind!=='current')current.set(k,v);
    if(!s.remote.has(keyFor('current','last'))&&!s.pending.some(p=>p.key===keyFor('current','last'))&&guest.has(keyFor('current','last')))current.set(keyFor('current','last'),guest.get(keyFor('current','last')));
    // Guest data stays untouched for safety. Duplicate IDs are not added.
    try{const state=fromRecords(app.get(),current);const applied=app.apply(state,{followPosition:true});saveState(s,applied);app.notice('Device records imported. Check Account for sync status.');}catch(e){app.notice('Import not saved. Download a backup and try again.');}
  };
  window.addEventListener('online',()=>{if(active){active.error=null;listen(active);flush(active);}});
  window.addEventListener('offline',()=>{if(active){active.online=false;updateStatus(active);}});
  window.addEventListener('storage',e=>{if(active&&e.key===cacheKey(active.user.uid)){active.pending=load(active.user.uid)?.pending||active.pending;updateStatus(active);flush(active);}});
  controls();
}
