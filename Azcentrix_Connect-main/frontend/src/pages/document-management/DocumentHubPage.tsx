// Document Hub – prototype v17 R.docs (no KPI strip, per request) + the current options:
// crumb Control · "Document hub" · New folder · Upload; .split: left .side = views (All files · My files · Shared with me · Starred · Trash),
// folders (shared + mine, with counts) and linked records (sources); right panel: .tbr search ("Drag files anywhere to upload · OCR indexing on")
// and the table Name (ext pill) | Folder | Tags | Linked to | Size | Ver | Owner | Updated | Status; drawer (docOpen): preview, Download · Share ·
// New version (+ Move · Star · Trash / Restore · Submit / Approve / Reject · Delete from the current module), tags, version history.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import { Pill, Tbl } from '@/pages/customers/kit'
import { dochubApi, errMsg, fd, size, type Doc, type Meta, type Version } from './dochubApi'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import '@/pages/leads/leads.css'
import '@/pages/settings/appSettings.css'
import '@/pages/settings/admin360.css'
import '@/pages/approvals/approvals.css'
import './dochub.css'

const PAGE = 25
const stone = (s: string) => (s === 'Approved' ? 'ok' : s === 'Rejected' ? 'ba' : s === 'Pending Approval' ? 'wa' : 'mu')
type Sel = { kind: 'view'; k: string } | { kind: 'folder'; id: number; name: string } | { kind: 'source'; k: string; l: string }

export default function DocumentHubPage() {
  const { success, error, info } = useToast()
  const [sp, setSp] = useSearchParams()
  const [meta, setMeta] = useState<Meta | null>(null)
  const [sel, setSel] = useState<Sel>({ kind: 'view', k: 'all' })
  const [q, setQ] = useState('')
  const [offset, setOffset] = useState(0)
  const [data, setData] = useState<{ items: Doc[]; total: number; loading: boolean }>({ items: [], total: 0, loading: true })
  const [rev, setRev] = useState(0)
  const [modal, setModal] = useState<{ t: 'folder' } | { t: 'upload'; versionOf?: Doc } | { t: 'renfolder'; id: number; name: string } | null>(null)
  const open = sp.get('open') || ''
  const setOpen = (id: string) => setSp(s => { const n = new URLSearchParams(s); if (id) n.set('open', id); else n.delete('open'); return n })
  const fileInput = useRef<HTMLInputElement>(null)
  const [dropFile, setDropFile] = useState<File | null>(null)

  const loadMeta = useCallback(() => dochubApi.meta().then(setMeta).catch(e => error(errMsg(e, 'Could not load the Document Hub'))), [error])
  useEffect(() => { loadMeta() }, [loadMeta, rev])
  const key = JSON.stringify([sel, q, offset, rev])
  useEffect(() => {
    let live = true
    setData(d => ({ ...d, loading: true }))
    const t = setTimeout(() => dochubApi.query({ view: sel.kind === 'view' ? sel.k : 'all', folder_id: sel.kind === 'folder' ? sel.id : null, source: sel.kind === 'source' ? sel.k : '', q, tag: '', offset, limit: PAGE })
      .then(r => { if (live) setData({ ...r, loading: false }) }).catch(e => { if (live) { setData(d => ({ ...d, loading: false })); error(errMsg(e, 'Could not load documents')) } }), q ? 150 : 0)
    return () => { live = false; clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const changed = useCallback(() => setRev(r => r + 1), [])
  const pick = (s: Sel) => { setSel(s); setOffset(0) }
  const onDrop = (e: React.DragEvent) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f && meta?.can_create) { setDropFile(f); setModal({ t: 'upload' }) } }
  const title = sel.kind === 'view' ? (meta?.views.find(v => v.k === sel.k)?.l || 'All files') : sel.kind === 'folder' ? sel.name : sel.l

  return <div className="bwi" onDragOver={e => e.preventDefault()} onDrop={onDrop}>
    <div className="pg"><div><div className="crumb">Control</div><h1>Document hub</h1></div><span className="fl" />
      {meta?.can_create && <><button type="button" className="btn" onClick={() => setModal({ t: 'folder' })}><Ic n="folder" /> New folder</button>
        <button type="button" className="btn p" onClick={() => { setDropFile(null); setModal({ t: 'upload' }) }}><Ic n="up" /> Upload</button></>}</div>
    <div className="split">
      <div className="panel dside"><div className="side">
        {(meta?.views || []).map(v => <div key={v.k} role="button" tabIndex={0} className={sel.kind === 'view' && sel.k === v.k ? 'on' : ''} onClick={() => pick({ kind: 'view', k: v.k })} onKeyDown={e => { if (e.key === 'Enter') pick({ kind: 'view', k: v.k }) }}>
          <Ic n={v.k === 'trash' ? 'trash' : v.k === 'starred' ? 'star' : v.k === 'shared' ? 'share' : 'folder'} /><span className="fl">{v.l}</span><small>{v.n}</small></div>)}
        <h6>Folders</h6>
        {(meta?.folders || []).map(f => <div key={f.id} role="button" tabIndex={0} className={sel.kind === 'folder' && sel.id === f.id ? 'on' : ''} onClick={() => pick({ kind: 'folder', id: f.id, name: f.name })} onKeyDown={e => { if (e.key === 'Enter') pick({ kind: 'folder', id: f.id, name: f.name }) }}>
          <Ic n="folder" /><span className="fl">{f.name}{f.shared && <span className="pill mu">shared</span>}</span><small>{f.n}</small>
          {f.mine && meta?.can_create && <a className="x" title="Rename" onClick={e => { e.stopPropagation(); setModal({ t: 'renfolder', id: f.id, name: f.name }) }}><Ic n="edit" size={12} /></a>}</div>)}
        {meta && !meta.folders.length && <div className="mu" style={{ padding: '6px 10px', cursor: 'default' }}><small>No folders yet</small></div>}
        <h6>Linked records</h6>
        {(meta?.sources || []).map(s => <div key={s.k} role="button" tabIndex={0} className={sel.kind === 'source' && sel.k === s.k ? 'on' : ''} onClick={() => pick({ kind: 'source', k: s.k, l: s.l })} onKeyDown={e => { if (e.key === 'Enter') pick({ kind: 'source', k: s.k, l: s.l }) }}>
          <Ic n="link" /><span className="fl">{s.l}</span></div>)}
      </div></div>
      <div className="panel" aria-busy={data.loading}>
        <div className="tbr"><input className="in" placeholder="Search files and tags…" value={q} onChange={e => { setQ(e.target.value); setOffset(0) }} aria-label="Search files" /><b className="mu" style={{ fontWeight: 500 }}>{title}</b><span className="fl" />
          <small>Drag files anywhere to upload{meta ? ` · ${size(meta.storage_kb)} used` : ''}</small></div>
        <div className="tw">
          <Tbl<Doc> rows={data.items} rowKey={r => r.id} onRow={r => setOpen(r.id)} empty={data.loading ? 'Loading…' : q ? 'No file matches the search.' : 'No documents here yet.'} cols={[
            { k: 'name', t: 'Name', fn: d => <><span className="pill mu">{d.ext}</span> <a><b>{d.name}</b></a>{d.is_starred && <span title="Starred" className="twarn"> ★</span>}</> },
            { k: 'folder', t: 'Folder' }, { k: 'tags', t: 'Tags', fn: d => <>{d.tags.map(t => <span key={t} className="pill ac" style={{ marginRight: 3 }}>{t}</span>)}</> },
            { k: 'link', t: 'Linked to', fn: d => d.link ? <span title={d.link_source}>{d.link}</span> : <span className="mu">—</span> },
            { k: 'size_kb', t: 'Size', r: true, fn: d => size(d.size_kb) }, { k: 'ver', t: 'Ver', fn: d => `v${d.ver}` }, { k: 'owner', t: 'Owner' },
            { k: 'updated', t: 'Updated', fn: d => fd(d.updated) }, { k: 'status', t: 'Status', fn: d => <Pill s={d.status} t={stone(d.status)} /> },
          ]} />
        </div>
        {data.total > PAGE && <div className="pgn"><span>{offset + 1}–{Math.min(offset + PAGE, data.total)} of {data.total}</span><span className="fl" />
          <button type="button" className="btn s" disabled={offset === 0} onClick={() => setOffset(o => Math.max(0, o - PAGE))}>‹ Prev</button>
          <button type="button" className="btn s" disabled={offset + PAGE >= data.total} onClick={() => setOffset(o => o + PAGE)}>Next ›</button></div>}
      </div>
    </div>
    <input ref={fileInput} type="file" hidden />
    {modal?.t === 'folder' && <FolderModal admin={!!meta?.folders.some(f => f.shared) || true} onClose={() => setModal(null)} onSave={(n, shared) => dochubApi.createFolder(n, shared).then(() => { setModal(null); changed(); success('Folder created') }).catch(e => error(errMsg(e)))} />}
    {modal?.t === 'renfolder' && <FolderModal name={modal.name} admin={false} onClose={() => setModal(null)} onSave={n => dochubApi.renameFolder(modal.id, n).then(() => { setModal(null); changed(); success('Folder renamed') }).catch(e => error(errMsg(e)))}
      onDelete={() => dochubApi.deleteFolder(modal.id).then(() => { setModal(null); if (sel.kind === 'folder' && sel.id === modal.id) pick({ kind: 'view', k: 'all' }); changed(); success('Folder deleted') }).catch(e => error(errMsg(e)))} />}
    {modal?.t === 'upload' && meta && <UploadModal meta={meta} file={dropFile} versionOf={modal.versionOf} folderId={sel.kind === 'folder' ? sel.id : null} onClose={() => setModal(null)}
      onDone={r => { setModal(null); changed(); success(modal.versionOf ? `Version ${r.version} uploaded` : 'Uploaded'); if (modal.versionOf) setOpen(r.document_id) }} />}
    {open && meta && <DocDrawer id={open} meta={meta} onClose={() => setOpen('')} onChanged={changed} onNewVersion={d => setModal({ t: 'upload', versionOf: d })} info={info} />}
  </div>
}

/* ───────────── modals ───────────── */
function FolderModal({ name, admin, onClose, onSave, onDelete }: { name?: string; admin: boolean; onClose: () => void; onSave: (n: string, shared: boolean) => void; onDelete?: () => void }) {
  const [n, setN] = useState(name || '')
  const [shared, setShared] = useState(false)
  return <Modal title={name ? 'Rename folder' : 'New folder'} width={420} onClose={onClose} foot={<>{onDelete && <button type="button" className="btn d" onClick={onDelete}>Delete folder</button>}<span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn p" disabled={!n.trim()} onClick={() => onSave(n.trim(), shared)}>{name ? 'Save' : 'Create'}</button></>}>
    <div className="fg"><div className="f1"><label>Folder name</label><input className="in" autoFocus value={n} onChange={e => setN(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && n.trim()) onSave(n.trim(), shared) }} /></div>
      {!name && admin && <div className="f1"><label className="row"><input type="checkbox" checked={shared} onChange={e => setShared(e.target.checked)} /> Shared with the whole company (administrators only)</label></div>}</div></Modal>
}

function UploadModal({ meta, file, versionOf, folderId, onClose, onDone }: { meta: Meta; file: File | null; versionOf?: Doc; folderId: number | null; onClose: () => void; onDone: (r: { document_id: string; version: number }) => void }) {
  const { error, info } = useToast()
  const [f, setF] = useState<File | null>(file)
  const [folder, setFolder] = useState<string>(versionOf ? String(versionOf.folder_id ?? '') : String(folderId ?? ''))
  const [tags, setTags] = useState(versionOf ? versionOf.tags.join(', ') : '')
  const [type, setType] = useState(versionOf?.doc_type || 'Uploaded Document')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!f) return info('Choose a file')
    setBusy(true)
    try {
      const fd = new FormData(); fd.append('file', f); if (folder) fd.append('folder_id', folder); fd.append('tags', tags); fd.append('doc_type', type); if (versionOf?.rid) fd.append('version_of', String(versionOf.rid))
      onDone(await dochubApi.upload(fd))
    } catch (e) { error(errMsg(e)) } finally { setBusy(false) }
  }
  return <Modal title={versionOf ? `New version · ${versionOf.name}` : 'Upload document'} width={520} onClose={onClose} foot={<><span className="fl" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn p" disabled={busy || !f} onClick={submit}>{busy ? 'Uploading…' : 'Upload'}</button></>}>
    <div className="fg">
      <div className="f1"><label>File</label><input className="in" type="file" onChange={e => setF(e.target.files?.[0] || null)} />{f && <small>{f.name} · {size(Math.round(f.size / 1024))}</small>}</div>
      {!versionOf && <div><label>Folder</label><select className="in" value={folder} onChange={e => setFolder(e.target.value)}><option value="">— no folder —</option>{meta.folders.map(x => <option key={x.id} value={x.id}>{x.name}{x.shared ? ' (shared)' : ''}</option>)}</select></div>}
      {!versionOf && <div><label>Document type</label><input className="in" value={type} onChange={e => setType(e.target.value)} /></div>}
      <div className="f1"><label>Tags (comma separated)</label><input className="in" value={tags} onChange={e => setTags(e.target.value)} placeholder="e.g. NIT, 2026, Delhi Metro" /></div>
    </div></Modal>
}

/* ───────────── drawer (prototype docOpen + current actions) ───────────── */
function DocDrawer({ id, meta, onClose, onChanged, onNewVersion, info }: { id: string; meta: Meta; onClose: () => void; onChanged: () => void; onNewVersion: (d: Doc) => void; info: (t: string) => void }) {
  const navigate = useNavigate()
  const { success, error } = useToast()
  const [d, setD] = useState<Doc | null>(null)
  const [vers, setVers] = useState<Version[]>([])
  const [tagTxt, setTagTxt] = useState('')
  const [busy, setBusy] = useState(false)
  const [modal, setModal] = useState<{ t: 'move' } | { t: 'share' } | { t: 'decide'; v: 'approve' | 'reject' } | { t: 'confirm'; title: string; body: ReactNode; ok: string; fn: () => Promise<unknown> } | null>(null)
  const load = useCallback(async () => {
    try {
      const rid = id.startsWith('standalone:') ? Number(id.split(':')[2]) : NaN
      const r = await dochubApi.query({ view: id.includes(':') && !Number.isNaN(rid) ? 'all' : 'all', folder_id: null, source: id.startsWith('standalone:') ? '' : id.split(':')[0], q: '', tag: '', offset: 0, limit: 200 })
      let doc = r.items.find(x => x.id === id) || null
      if (!doc && !Number.isNaN(rid)) { const t = await dochubApi.query({ view: 'trash', folder_id: null, source: '', q: '', tag: '', offset: 0, limit: 200 }); doc = t.items.find(x => x.id === id) || null }
      setD(doc); setTagTxt(doc ? doc.tags.join(', ') : '')
      if (doc?.rid) setVers(await dochubApi.versions(doc.rid)); else setVers([])
    } catch (e) { error(errMsg(e, 'Could not open this document')) }
  }, [id, error])
  useEffect(() => { setD(null); void load() }, [load])
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !modal) onClose() }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h) }, [onClose, modal])
  const host = document.querySelector('.crm-shell') ?? document.body
  const run = async (msg: string, fn: () => Promise<unknown>, close = false) => { setBusy(true); try { await fn(); success(msg); onChanged(); if (close) onClose(); else await load() } catch (e) { error(errMsg(e)) } finally { setBusy(false) } }
  const isImg = !!d && /^(PNG|JPG|JPEG|GIF|WEBP|SVG)$/.test(d.ext)
  const isPdf = !!d && d.ext === 'PDF'
  return createPortal(<div className="bwi">
    <div className="bwi-dwo" onMouseDown={onClose} />
    <aside className="bwi-dw" role="dialog" aria-modal="true" aria-label={d?.name || 'Document'}>
      <div className="dh"><div className="fl"><h2>{d?.name || 'Loading…'}</h2>{d && <div className="sub">{d.folder || 'No folder'} · v{d.ver} · <Pill s={d.status} t={stone(d.status)} />{d.deleted_at && <Pill s="In trash" t="ba" />}</div>}</div>
        <button type="button" className="btn g ib" onClick={onClose} aria-label="Close"><Ic n="x" /></button></div>
      <div className="db">{!d ? <div className="empty">Loading…</div> : <>
        <div className="prev">{d.url && isImg ? <img src={d.url} alt={d.name} /> : d.url && isPdf ? <iframe src={d.url} title={d.name} /> : <div className="ph"><Ic n="file" size={28} /><div>Preview<br /><small>{d.name}</small></div></div>}</div>
        <div className="row mt mb wrap">
          {d.url && <a className="btn p" href={d.url} target="_blank" rel="noreferrer" download><Ic n="dl" /> Download</a>}
          {!d.deleted_at && <button type="button" className="btn" onClick={() => setModal({ t: 'share' })}><Ic n="link" /> Share</button>}
          {d.rid && !d.deleted_at && meta.can_create && (d.is_mine || true) && <button type="button" className="btn" onClick={() => onNewVersion(d)}><Ic n="up" /> New version</button>}
          {d.rid && !d.deleted_at && <button type="button" className="btn" onClick={() => setModal({ t: 'move' })}><Ic n="folder" /> Move</button>}
          <button type="button" className="btn" disabled={busy} onClick={() => run(d.is_starred ? 'Star removed' : 'Starred', () => dochubApi.star(d.id))}><Ic n="star" /> {d.is_starred ? 'Unstar' : 'Star'}</button>
          {d.can_submit && d.rid && !d.deleted_at && <button type="button" className="btn" disabled={busy} onClick={() => run('Submitted for approval', () => dochubApi.submit(d.id))}><Ic n="check" /> Submit for approval</button>}
          {d.can_approve && <><button type="button" className="btn p" onClick={() => setModal({ t: 'decide', v: 'approve' })}>Approve</button><button type="button" className="btn d" onClick={() => setModal({ t: 'decide', v: 'reject' })}>Reject</button></>}
          {d.deleted_at ? <><button type="button" className="btn" disabled={busy} onClick={() => run('Restored', () => dochubApi.restore(d.id), true)}>Restore</button>
            <button type="button" className="btn d" onClick={() => setModal({ t: 'confirm', title: 'Delete forever', body: <>Permanently delete “{d.name}”? This cannot be undone.</>, ok: 'Delete forever', fn: () => dochubApi.remove(d.id) })}>Delete forever</button></>
            : d.can_trash && <button type="button" className="btn d" onClick={() => setModal({ t: 'confirm', title: 'Move to trash', body: <>Move “{d.name}” to the trash?</>, ok: 'Trash', fn: () => dochubApi.trash(d.id) })}><Ic n="trash" /> Trash</button>}
        </div>
        <div className="kv">{([['Folder', d.folder || '—'], ['Linked to', d.link ? <a onClick={() => d.link_source && navigate(`/${d.link_source === 'standalone' ? 'document-management' : d.link_source}`)}>{d.link}</a> : '—'], ['Size', size(d.size_kb)], ['Owner', d.owner], ['Uploaded', fd(d.updated)], ['Type', d.doc_type || '—']] as [string, ReactNode][]).map(([l, v]) => <div key={l}><span>{l}</span><span>{v}</span></div>)}</div>
        {d.rid && <><h3 className="mt mb">Tags</h3><div className="row"><input className="in" value={tagTxt} onChange={e => setTagTxt(e.target.value)} placeholder="tag, tag" disabled={!d.is_mine && !meta.can_create} />
          <button type="button" className="btn s" disabled={busy || tagTxt === d.tags.join(', ')} onClick={() => run('Tags saved', () => dochubApi.setTags(d.rid!, tagTxt.split(',').map(x => x.trim()).filter(Boolean)))}>Save</button></div></>}
        <h3 className="mt mb">Version history</h3>
        {vers.length ? <div className="tl">{vers.map(v => <div key={v.rid}><b>v{v.ver}</b> {v.current && <Pill s="Current" t="ok" />}{v.deleted && <Pill s="Trashed" t="mu" />}<br /><small>{v.by} · {fd(v.d)} · {size(v.size_kb)}</small>{v.url && <> · <a href={v.url} target="_blank" rel="noreferrer">open</a></>}</div>)}</div>
          : <div className="tl"><div><b>v{d.ver}</b> <Pill s="Current" t="ok" /><br /><small>{d.owner} · {fd(d.updated)}</small></div></div>}
      </>}</div>
    </aside>
    {modal?.t === 'move' && d && <Modal title="Move to folder" width={420} onClose={() => setModal(null)} foot={<><span className="fl" /><button type="button" className="btn" onClick={() => setModal(null)}>Cancel</button></>}>
      <div className="list bx">{[{ id: null as number | null, name: '— no folder —' }, ...meta.folders].map(f => <div key={String(f.id)} role="button" onClick={() => { setModal(null); void run('Moved', () => dochubApi.move(d.id, f.id)) }} style={{ cursor: 'pointer' }}><Ic n="folder" /><span className="fl">{f.name}</span>{f.id === d.folder_id && <small>current</small>}</div>)}</div></Modal>}
    {modal?.t === 'share' && d && <ShareModal onClose={() => setModal(null)} onOk={ids => { setModal(null); void run(ids.length ? 'Shared' : 'Share link copied', async () => { if (ids.length) await dochubApi.share(d.id, ids); if (d.url) { try { await navigator.clipboard.writeText(d.url) } catch { info('Copy the link from the Download button') } } }) }} />}
    {modal?.t === 'decide' && d && <DecideModal v={modal.v} onClose={() => setModal(null)} onOk={c => { setModal(null); void run(modal.v === 'approve' ? 'Approved' : 'Rejected', () => (modal.v === 'approve' ? dochubApi.approve(d.id, c) : dochubApi.reject(d.id, c))) }} />}
    {modal?.t === 'confirm' && <Modal title={modal.title} width={420} onClose={() => setModal(null)} foot={<><span className="fl" /><button type="button" className="btn" onClick={() => setModal(null)}>Cancel</button><button type="button" className="btn d" onClick={() => { const fn = modal.fn; setModal(null); void run(modal.ok === 'Trash' ? 'Moved to trash' : 'Deleted', fn, true) }}>{modal.ok}</button></>}><p style={{ margin: 0 }}>{modal.body}</p></Modal>}
  </div>, host)
}

function ShareModal({ onClose, onOk }: { onClose: () => void; onOk: (ids: number[]) => void }) {
  const [people, setPeople] = useState<{ id: number; name: string; email: string }[]>([])
  const [sel, setSel] = useState<Set<number>>(new Set())
  useEffect(() => { dochubApi.people().then(setPeople).catch(() => setPeople([])) }, [])
  return <Modal title="Share document" width={460} onClose={onClose} foot={<><span className="fl" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn p" onClick={() => onOk([...sel])}>{sel.size ? `Share with ${sel.size}` : 'Copy link'}</button></>}>
    <p className="mu" style={{ marginTop: 0 }}>Pick colleagues to share with, or just copy the link.</p>
    <div className="list bx" style={{ maxHeight: 260, overflow: 'auto' }}>{people.map(p => <div key={p.id}><label className="row" style={{ gap: 6, cursor: 'pointer' }}><input type="checkbox" checked={sel.has(p.id)} onChange={e => setSel(s => { const n = new Set(s); if (e.target.checked) n.add(p.id); else n.delete(p.id); return n })} /> {p.name} <small className="mu">{p.email}</small></label></div>)}</div></Modal>
}

function DecideModal({ v, onClose, onOk }: { v: 'approve' | 'reject'; onClose: () => void; onOk: (c: string) => void }) {
  const [c, setC] = useState('')
  return <Modal title={v === 'approve' ? 'Approve document' : 'Reject document'} width={420} onClose={onClose} foot={<><span className="fl" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className={`btn ${v === 'approve' ? 'p' : 'd'}`} disabled={v === 'reject' && !c.trim()} onClick={() => onOk(c.trim())}>{v === 'approve' ? 'Approve' : 'Reject'}</button></>}>
    <div className="fg"><div className="f1"><label>Comment{v === 'reject' ? ' (required)' : ''}</label><textarea className="in" rows={3} autoFocus value={c} onChange={e => setC(e.target.value)} /></div></div></Modal>
}
