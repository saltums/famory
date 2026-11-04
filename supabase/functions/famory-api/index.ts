// ファモリ(famory) API — GAS版 doGet/doPost の置き換え
// フロントとの互換性のため、レスポンスは旧スプレッドシートと同じ日本語キーで返す。
import { createClient } from 'npm:@supabase/supabase-js@2'

const PCLOUD_HOST = Deno.env.get('PCLOUD_API_HOST') ?? 'api.pcloud.com'
const PCLOUD_TOKEN = Deno.env.get('PCLOUD_TOKEN') ?? ''
const PCLOUD_PARENT_ID = 30782397954 // ファモリ写真の親フォルダ

const db = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

// ---------- pCloud ----------
const AUTH_ERRORS = [1000, 2000, 2094, 2095]
// US/EU どちらのデータセンターのアカウントでも動くよう、認証エラー時はもう一方のホストも試す
let host = PCLOUD_HOST
const otherHost = (h: string) => (h === 'api.pcloud.com' ? 'eapi.pcloud.com' : 'api.pcloud.com')
async function pcRaw(h: string, method: string, params: Record<string, string | number>) {
  const q = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), auth: PCLOUD_TOKEN })
  const r = await fetch(`https://${h}/${method}?${q}`)
  return await r.json()
}
async function pc(method: string, params: Record<string, string | number>) {
  let d = await pcRaw(host, method, params)
  if (AUTH_ERRORS.includes(d.result)) {
    const alt = otherHost(host)
    const d2 = await pcRaw(alt, method, params)
    if (!AUTH_ERRORS.includes(d2.result)) { host = alt; d = d2 }
  }
  if (AUTH_ERRORS.includes(d.result)) throw new Error(`pCloudの認証エラー (${d.result})。Supabaseの PCLOUD_TOKEN を確認してください。`)
  return d
}

async function ensureFolder(parentId: number, name: string): Promise<number> {
  const d = await pc('createfolderifnotexists', { folderid: parentId, name })
  if (d.result !== 0) throw new Error(`フォルダ「${name}」の作成に失敗しました (pCloud Error: ${d.result} ${d.error ?? ''})`)
  return d.metadata.folderid
}

async function uniqueName(parentId: number, base: string): Promise<string> {
  const d = await pc('listfolder', { folderid: parentId })
  if (d.result !== 0) throw new Error(`フォルダ一覧の取得に失敗しました (pCloud Error: ${d.result})`)
  const names = new Set((d.metadata.contents ?? []).filter((c: any) => c.isfolder).map((c: any) => c.name))
  if (!names.has(base)) return base
  let i = 1
  while (names.has(`${base}-${i}`)) i++
  return `${base}-${i}`
}

async function makeLinks(folderId: number, title: string) {
  const pub = await pc('getfolderpublink', { folderid: folderId })
  if (pub.result !== 0 && pub.result !== 2004) throw new Error(`pCloud共有リンク作成エラー(${pub.result}): ${pub.error ?? ''}`)
  const up = await pc('createuploadlink', { folderid: folderId, comment: `Famory_${title || 'Upload'}` })
  if (up.result !== 0) throw new Error(`pCloudアップロードリンク作成エラー(${up.result}): ${up.error ?? ''}`)
  return { pcloud_url: pub.link ?? null, pcloud_upload_url: up.link as string }
}

async function createEventFolder(date: string): Promise<number> {
  const [y, m, d] = date.split('-')
  const yearId = await ensureFolder(PCLOUD_PARENT_ID, y)
  const name = await uniqueName(yearId, `${y.slice(2)}${m}${d}`)
  return await ensureFolder(yearId, name)
}

// ---------- 変換 ----------
const toJa = (r: any) => ({
  ID: r.id,
  日付: r.date,
  タイトル: r.title,
  詳細: r.detail ?? '',
  場所: r.location ?? '',
  pCloudURL: r.pcloud_url ?? '',
  pCloudUploadURL: r.pcloud_upload_url ?? '',
  pCloudFolderID: r.pcloud_folder_id ?? '',
  共有範囲: r.share_range,
  登録者: r.created_by ?? '',
})

function visibleRanges(role: string): string[] | null {
  if (role === 'admin') return null
  if (role === 'paternal') return ['全員', '大塚家']
  if (role === 'maternal') return ['全員', '石川家']
  return ['全員']
}

// ---------- actions ----------
async function getEvents(role: string) {
  let q = db.from('famory_events').select('*').order('date', { ascending: false })
  const ranges = visibleRanges(role)
  if (ranges) q = q.in('share_range', ranges)
  const { data, error } = await q
  if (error) throw error
  return data.map(toJa)
}

async function addEvent(p: any) {
  if (!p.date || !p.title) throw new Error('日付とタイトルは必須です')
  const folderId = await createEventFolder(p.date)
  const links = await makeLinks(folderId, p.title)
  const row = {
    id: `EV-${Date.now()}`,
    date: p.date,
    title: p.title,
    detail: p.detail || null,
    location: p.location || null,
    share_range: p.range || '全員',
    created_by: p.role === 'admin' ? '管理者' : p.role === 'paternal' ? '大塚家' : '石川家',
    pcloud_folder_id: folderId,
    ...links,
  }
  const { error } = await db.from('famory_events').insert(row)
  if (error) throw error
  return { success: true, id: row.id, folderId, pCloudURL: links.pcloud_url, pCloudUploadURL: links.pcloud_upload_url }
}

async function addPhotos(p: any) {
  const { data: ev, error } = await db.from('famory_events').select('*').eq('id', p.id).maybeSingle()
  if (error) throw error
  if (!ev) throw new Error('イベントが見つかりません')
  const folderId = ev.pcloud_folder_id ?? await createEventFolder(ev.date)
  const links = await makeLinks(folderId, ev.title)
  const { error: upErr } = await db.from('famory_events').update({
    pcloud_folder_id: folderId,
    pcloud_upload_url: links.pcloud_upload_url,
    ...(links.pcloud_url ? { pcloud_url: links.pcloud_url } : {}),
  }).eq('id', ev.id)
  if (upErr) throw upErr
  return { success: true, folderId, pCloudUploadURL: links.pcloud_upload_url }
}

async function deleteEvent(p: any) {
  if (p.role !== 'admin') throw new Error('削除権限がありません')
  const { error, count } = await db.from('famory_events').delete({ count: 'exact' }).eq('id', p.id)
  if (error) throw error
  return { success: (count ?? 0) > 0 }
}

// ---------- entry ----------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    if (req.method === 'GET') {
      const url = new URL(req.url)
      const action = url.searchParams.get('action')
      const role = (url.searchParams.get('role') || 'guest').toLowerCase()
      if (action === 'getEvents') return json(await getEvents(role))
      if (action === 'health') {
        // pCloud認証と親フォルダへのアクセス確認（読み取りのみ）
        const d = await pc('listfolder', { folderid: PCLOUD_PARENT_ID, nofiles: 1 })
        return json({ ok: d.result === 0, host, pcloud: d.result, folders: d.metadata?.contents?.map((c: any) => c.name) ?? [] })
      }
      return json({ status: 'running', role })
    }
    const p = JSON.parse(await req.text())
    try {
      switch (p.action) {
        case 'addEvent': return json(await addEvent(p))
        case 'addPhotos': return json(await addPhotos(p))
        case 'deleteEvent': return json(await deleteEvent(p))
        default: return json({ success: false, error: 'Unknown action' })
      }
    } catch (e) {
      console.error(p.action, e)
      return json({ success: false, error: String(e instanceof Error ? e.message : e) })
    }
  } catch (e) {
    console.error(e)
    return json({ error: String(e instanceof Error ? e.message : e) })
  }
})
