import { startTransition, useEffect, useRef, useState } from 'react'
import { createMockDashboardData, tickDashboardData } from './mockData'
import type {
  DashboardData,
  DeviceDecision,
  DeviceEntry,
  DeviceStatus,
  FingerprintBundle,
  FingerprintMatrix,
  HistoryRecord,
  JoiningDevice,
  OfflineDevice,
} from './types'

const LIVE_ENABLED = import.meta.env.VITE_ENABLE_LIVE !== 'false'
const COORDINATOR_HTTP_BASE = trimTrailingSlash(
  import.meta.env.VITE_COORDINATOR_HTTP_BASE ?? 'http://127.0.0.1:8787',
)
const FINGERPRINT_HTTP_BASE = trimTrailingSlash(
  import.meta.env.VITE_FINGERPRINT_HTTP_BASE ?? 'http://127.0.0.1:8788',
)
const POLL_INTERVAL_MS = clampPollInterval(
  Number(import.meta.env.VITE_COORDINATOR_POLL_INTERVAL_MS ?? 3000),
)

interface CoordinatorStatusResponse {
  coordinator?: {
    online?: boolean
    host_link_ready?: boolean
    pan_id?: string
    channel?: number
    short_addr?: string
    ieee_addr?: string
    permit_join_open?: boolean
    permit_join_remaining?: number
    network_state?: string
    startup_factory_new?: boolean
    last_event_type?: string
    last_event_at?: string
    model_identifier?: string
  }
  rf_pipeline?: {
    model_loaded?: boolean
    unknown_policy?: string
    last_error?: string
  }
  policy?: {
    known_device_policy?: string
  }
  pending_counts?: {
    access_requests?: number
    rf_samples?: number
  }
}

interface CoordinatorDeviceResponse {
  items?: CoordinatorDevice[]
  count?: number
}

interface CoordinatorDevice {
  short_addr?: string
  ieee_addr?: string | null
  capability?: string | null
  status?: string | null
  last_event_type?: string | null
  last_seen_at?: string | null
  last_decision?: string | null
  last_decision_at?: string | null
  parent_short?: string | null
  update_status?: string | null
  tc_action?: string | null
  rejoin?: boolean | null
  last_rf_trace_id?: string | null
  last_match_delta_ms?: number | null
  last_pred_label?: string | null
  last_pred_confidence?: number | null
  last_pred_is_unknown?: boolean | null
  last_admission_id?: string | null
  metadata?: Record<string, unknown>
}

interface AdmissionPrediction {
  label?: string
  confidence?: number
  is_unknown?: boolean
}

interface AdmissionTiming {
  match_delta_ms?: number | null
  infer_ms?: number | null
  total_ms?: number | null
}

interface AdmissionRequestSummary {
  seq?: number
  short_addr?: string
  capability?: string
  pan_id?: string
  channel?: number
  model?: string
  request_ts?: string
  received_at?: string
}

interface AdmissionSampleSummary {
  trace_id?: string
  sample_ts?: string
  received_at?: string
}

interface AdmissionsResponse {
  items?: AdmissionSummary[]
  count?: number
}

interface AdmissionSummary {
  admission_id?: string
  status?: string
  created_at?: string
  updated_at?: string
  request?: AdmissionRequestSummary
  rf_sample?: AdmissionSampleSummary | null
  pred?: AdmissionPrediction | null
  decision?: string | null
  reason?: string | null
  error?: string | null
  timing?: AdmissionTiming | null
}

interface AdmissionDetailResponse extends AdmissionSummary {
  iq?: {
    real?: number[]
    imag?: number[]
  } | null
  gaf?: {
    shape?: Array<number | string>
    data?: unknown
  } | null
}

interface ReferenceFingerprintResponse {
  ieee_addr?: string
  shape?: number[]
  channels?: number[][][]
}

interface DashboardConnectionState {
  mode: 'mock' | 'live'
  coordinatorConnected: boolean
  inferConnected: boolean
  lastError: string | null
}

type ModalTarget = DeviceEntry | JoiningDevice | HistoryRecord

export function useDashboardData() {
  const [data, setData] = useState<DashboardData>(() =>
    LIVE_ENABLED ? createLiveDashboardData() : createMockDashboardData(),
  )
  const [connection, setConnection] = useState<DashboardConnectionState>({
    mode: LIVE_ENABLED ? 'live' : 'mock',
    coordinatorConnected: false,
    inferConnected: false,
    lastError: null,
  })
  const admissionCacheRef = useRef(new Map<string, AdmissionDetailResponse>())
  const admissionCacheVersionRef = useRef(new Map<string, string>())
  const admissionRequestRef = useRef(new Map<string, Promise<AdmissionDetailResponse | null>>())
  const referenceFingerprintCacheRef = useRef(new Map<string, FingerprintMatrix[] | null>())
  const referenceFingerprintRequestRef = useRef(new Map<string, Promise<FingerprintMatrix[] | null>>())

  const setError = (message: string) => {
    setConnection((previous) => ({
      ...previous,
      lastError: message,
    }))
  }

  const loadAdmissionDetailById = async (
    admissionId: string,
    updatedAt = '',
    signal?: AbortSignal,
    force = false,
  ) => {
    const admissionCache = admissionCacheRef.current
    const admissionCacheVersion = admissionCacheVersionRef.current
    const cachedVersion = admissionCacheVersion.get(admissionId) ?? ''
    if (!force && admissionCache.has(admissionId) && (!updatedAt || cachedVersion === updatedAt)) {
      return admissionCache.get(admissionId) ?? null
    }

    const pending = admissionRequestRef.current.get(admissionId)
    if (pending) {
      return pending
    }

    const request = (async () => {
      try {
        const detail = await fetchJson<AdmissionDetailResponse>(
          `${COORDINATOR_HTTP_BASE}/api/v2/admissions/${admissionId}`,
          signal,
          force ? 'no-store' : 'default',
        )
        admissionCache.set(admissionId, detail)
        admissionCacheVersion.set(admissionId, updatedAt || detail.updated_at || cachedVersion)
        pruneAdmissionCache(admissionCache, admissionCacheVersion)
        return detail
      } catch (error) {
        if (!signal?.aborted) {
          setError(
            error instanceof Error ? `准入详情加载失败: ${error.message}` : '准入详情加载失败',
          )
        }
        return admissionCache.get(admissionId) ?? null
      } finally {
        admissionRequestRef.current.delete(admissionId)
      }
    })()

    admissionRequestRef.current.set(admissionId, request)
    return request
  }

  const loadReferenceFingerprintByIeee = async (
    ieeeAddr: string,
    signal?: AbortSignal,
    force = false,
  ) => {
    const normalizedIeeeAddr = ieeeAddr.trim()
    if (!LIVE_ENABLED || !normalizedIeeeAddr || normalizedIeeeAddr === '--') {
      return null
    }

    const cache = referenceFingerprintCacheRef.current
    if (!force && cache.has(normalizedIeeeAddr)) {
      return cache.get(normalizedIeeeAddr) ?? null
    }

    const pending = referenceFingerprintRequestRef.current.get(normalizedIeeeAddr)
    if (pending) {
      return pending
    }

    const request = (async () => {
      try {
        const response = await fetchJson<ReferenceFingerprintResponse>(
          `${FINGERPRINT_HTTP_BASE}/api/v1/fingerprint/reference`,
          signal,
          force ? 'no-store' : 'default',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify({
              ieee_addr: normalizedIeeeAddr,
            }),
          },
        )
        const reference = buildReferenceHeatmaps(response)
        cache.set(normalizedIeeeAddr, reference)
        return reference
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) {
          cache.set(normalizedIeeeAddr, null)
          return null
        }

        if (!signal?.aborted) {
          setError(
            error instanceof Error ? `参考指纹图加载失败: ${error.message}` : '参考指纹图加载失败',
          )
        }
        return cache.get(normalizedIeeeAddr) ?? null
      } finally {
        referenceFingerprintRequestRef.current.delete(normalizedIeeeAddr)
      }
    })()

    referenceFingerprintRequestRef.current.set(normalizedIeeeAddr, request)
    return request
  }

  const loadAdmissionTarget = async (target: ModalTarget) => {
    if (!LIVE_ENABLED) {
      return target
    }

    let nextTarget = target
    const admissionId = getTargetAdmissionId(target)
    if (admissionId) {
      const detail = await loadAdmissionDetailById(admissionId, '', undefined, true)
      if (detail) {
        nextTarget = hydrateTargetWithAdmissionDetail(nextTarget, detail)
      }
    }

    const referenceIeeeAddr = resolveReferenceFingerprintIeeeAddr(nextTarget, data.offlineDevices)
    if (!referenceIeeeAddr) {
      return nextTarget
    }

    const reference = await loadReferenceFingerprintByIeee(referenceIeeeAddr)
    return reference?.length ? hydrateTargetWithReferenceFingerprint(nextTarget, reference) : nextTarget
  }

  useEffect(() => {
    if (!LIVE_ENABLED) {
      const interval = window.setInterval(() => {
        startTransition(() => {
          setData((previous) => tickDashboardData(previous))
        })
      }, 4800)

      return () => window.clearInterval(interval)
    }

    const abortController = new AbortController()
    const admissionCache = admissionCacheRef.current
    let disposed = false
    let refreshTimer: number | null = null

    const scheduleRefresh = () => {
      if (disposed || refreshTimer !== null) {
        return
      }

      refreshTimer = window.setTimeout(() => {
        refreshTimer = null
        void refreshCoordinatorState()
      }, POLL_INTERVAL_MS)
    }

    const warmAdmissionCache = async (
      admissions: AdmissionSummary[],
      deviceItems: CoordinatorDevice[],
    ) => {
      const targets = new Map<string, string>()

      for (const summary of admissions) {
        if (summary.admission_id) {
          targets.set(summary.admission_id, summary.updated_at ?? '')
        }
      }

      for (const item of deviceItems) {
        if (item.last_admission_id && !targets.has(item.last_admission_id)) {
          targets.set(item.last_admission_id, '')
        }
      }

      if (targets.size === 0) {
        return
      }

      await Promise.all(
        Array.from(targets.entries(), ([admissionId, updatedAt]) =>
          loadAdmissionDetailById(admissionId, updatedAt, abortController.signal),
        ),
      )
    }

    const refreshCoordinatorState = async () => {
      try {
        const [status, devices, admissions] = await Promise.all([
          fetchJson<CoordinatorStatusResponse>(`${COORDINATOR_HTTP_BASE}/api/v2/status`, abortController.signal),
          fetchJson<CoordinatorDeviceResponse>(`${COORDINATOR_HTTP_BASE}/api/v2/devices`, abortController.signal),
          fetchJson<AdmissionsResponse>(`${COORDINATOR_HTTP_BASE}/api/v2/admissions?limit=10`, abortController.signal),
        ])

        await warmAdmissionCache(admissions.items ?? [], devices.items ?? [])

        if (abortController.signal.aborted || disposed) {
          return
        }

        const latestAdmissionId = admissions.items?.[0]?.admission_id
        const latestDetail = latestAdmissionId ? admissionCache.get(latestAdmissionId) ?? null : null

        startTransition(() => {
          setData((previous) =>
            mergeCoordinatorState(previous, status, devices, admissions, latestDetail, admissionCache),
          )
        })

        setConnection((previous) => ({
          ...previous,
          mode: 'live',
          coordinatorConnected: Boolean(status.coordinator?.online || status.coordinator?.host_link_ready),
          inferConnected: Boolean(status.rf_pipeline?.model_loaded),
          lastError: null,
        }))
      } catch (error) {
        if (abortController.signal.aborted) {
          return
        }

        setConnection((previous) => ({
          ...previous,
          coordinatorConnected: false,
          inferConnected: false,
        }))
        setError(error instanceof Error ? error.message : '加载协调器状态失败')
      } finally {
        scheduleRefresh()
      }
    }

    void refreshCoordinatorState()

    return () => {
      disposed = true
      abortController.abort()
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer)
      }
    }
  }, [])

  return {
    data,
    connection,
    liveEnabled: LIVE_ENABLED,
    loadAdmissionTarget,
    loadReferenceFingerprintByIeee,
  }
}

function getTargetAdmissionId(target: ModalTarget) {
  if ('joinStage' in target || 'fingerprintId' in target) {
    return target.admissionId
  }

  return target.admissionId ?? (typeof target.id === 'string' ? target.id : null)
}

function hydrateTargetWithAdmissionDetail(target: ModalTarget, detail: AdmissionDetailResponse): ModalTarget {
  const primary = buildHeatmapsFromGaf(detail.gaf) ?? target.fingerprint.primary

  if ('joinStage' in target) {
    return {
      ...target,
      admissionId: target.admissionId ?? detail.admission_id ?? null,
      iqSamples: {
        real: sanitizeSeries(detail.iq?.real, target.iqSamples.real),
        imag: sanitizeSeries(detail.iq?.imag, target.iqSamples.imag),
      },
      fingerprint: {
        ...target.fingerprint,
        primary,
      },
    }
  }

  if ('fingerprintId' in target) {
    return {
      ...target,
      admissionId: target.admissionId ?? detail.admission_id ?? null,
      fingerprint: {
        ...target.fingerprint,
        primary,
      },
    }
  }

  return {
    ...target,
    admissionId: target.admissionId ?? detail.admission_id ?? null,
    fingerprint: {
      ...target.fingerprint,
      primary,
    },
  }
}

function hydrateTargetWithReferenceFingerprint(
  target: ModalTarget,
  reference: FingerprintMatrix[],
): ModalTarget {
  return {
    ...target,
    fingerprint: {
      ...target.fingerprint,
      reference,
    },
  }
}

function pruneAdmissionCache(
  admissionCache: Map<string, AdmissionDetailResponse>,
  admissionCacheVersion: Map<string, string>,
) {
  while (admissionCache.size > 24) {
    const oldestKey = admissionCache.keys().next().value
    if (!oldestKey) {
      break
    }
    admissionCache.delete(oldestKey)
    admissionCacheVersion.delete(oldestKey)
  }
}

class HttpError extends Error {
  status: number

  constructor(status: number, statusText: string) {
    super(`请求失败: ${status} ${statusText}`)
    this.status = status
  }
}

async function fetchJson<T>(
  url: string,
  signal?: AbortSignal,
  cache: RequestCache = 'default',
  init?: RequestInit,
) {
  const response = await fetch(url, {
    ...init,
    signal,
    cache,
  })
  if (!response.ok) {
    throw new HttpError(response.status, response.statusText)
  }

  return (await response.json()) as T
}

function mergeCoordinatorState(
  previous: DashboardData,
  status: CoordinatorStatusResponse,
  devices: CoordinatorDeviceResponse,
  admissions: AdmissionsResponse,
  latestDetail: AdmissionDetailResponse | null,
  admissionCache: Map<string, AdmissionDetailResponse>,
): DashboardData {
  if (latestDetail?.admission_id) {
    admissionCache.set(latestDetail.admission_id, latestDetail)
  }

  const latestAdmissionByShortAddr = buildLatestAdmissionByShortAddr(admissions.items ?? [])

  const mappedDevices = (devices.items ?? []).map((item) =>
    mapDevice(
      item,
      previous.devices,
      admissionCache,
      previous.offlineDevices,
      latestAdmissionByShortAddr,
    ),
  )
  const mappedHistory = mapHistory(
    admissions.items ?? [],
    mappedDevices,
    admissionCache,
    previous.offlineDevices,
  )
  const joiningDevice = mapLatestAdmission(
    admissions.items?.[0] ?? null,
    mappedDevices,
    latestDetail,
    previous.offlineDevices,
  )

  return {
    ...previous,
    tick: previous.tick + 1,
    coordinator: {
      ...previous.coordinator,
      ieeeAddr: status.coordinator?.ieee_addr ?? previous.coordinator.ieeeAddr,
      panId: status.coordinator?.pan_id ?? previous.coordinator.panId,
      channel: status.coordinator?.channel ?? previous.coordinator.channel,
      permitJoinOpen: status.coordinator?.permit_join_open ?? previous.coordinator.permitJoinOpen,
      permitJoinRemaining:
        status.coordinator?.permit_join_remaining ?? previous.coordinator.permitJoinRemaining,
      decisionMode:
        status.policy?.known_device_policy ??
        status.rf_pipeline?.unknown_policy ??
        previous.coordinator.decisionMode,
      pendingRequests:
        status.pending_counts?.access_requests ?? previous.coordinator.pendingRequests,
      deviceCount: devices.count ?? mappedDevices.length,
      modelIdentifier:
        status.coordinator?.model_identifier ?? previous.coordinator.modelIdentifier,
      networkState: status.coordinator?.network_state ?? previous.coordinator.networkState,
    },
    devices: mappedDevices,
    history: mappedHistory,
    joiningDevice,
  }
}

function mapDevice(
  item: CoordinatorDevice,
  previousDevices: DeviceEntry[],
  admissionCache: Map<string, AdmissionDetailResponse>,
  offlineDevices: OfflineDevice[],
  latestAdmissionByShortAddr: Map<string, AdmissionSummary>,
): DeviceEntry {
  const previous = previousDevices.find(
    (device) =>
      (item.ieee_addr && device.ieeeAddr === item.ieee_addr) ||
      (item.short_addr && device.shortAddr === item.short_addr),
  )
  const capability = item.capability ?? previous?.capability ?? '0x00'
  const shortAddr = item.short_addr ?? previous?.shortAddr ?? '--'
  const ieeeAddr = item.ieee_addr ?? previous?.ieeeAddr ?? '--'
  const fingerprintId =
    item.last_pred_label ??
    readString(item.metadata?.fingerprint_id) ??
    previous?.fingerprintId ??
    'unknown'
  const matchedConfidence = clampNumber(
    item.last_pred_confidence ?? readNumber(item.metadata?.score),
    previous?.matchedConfidence ?? 0,
  )
  const fallbackAdmissionId = latestAdmissionByShortAddr.get(shortAddr)?.admission_id ?? null
  const admissionId = item.last_admission_id ?? fallbackAdmissionId ?? previous?.admissionId ?? null
  const detail = admissionId ? admissionCache.get(admissionId) : null
  const primary = buildHeatmapsFromGaf(detail?.gaf) ?? previous?.fingerprint.primary ?? []
  const reference =
    findReferenceFingerprint(fingerprintId, offlineDevices) ?? previous?.fingerprint.reference ?? []

  return {
    ieeeAddr,
    shortAddr,
    role: inferRole(capability, shortAddr),
    capability,
    status: normalizeDeviceStatus(item.status, item.last_decision),
    lastDecision: normalizeDecision(item.last_decision, item.status),
    lastSeenAt:
      item.last_seen_at ?? item.last_decision_at ?? previous?.lastSeenAt ?? new Date().toISOString(),
    fingerprintId,
    signalScore: Math.round(matchedConfidence * 100),
    matchedConfidence,
    parentShort: item.parent_short ?? previous?.parentShort ?? '--',
    admissionId,
    fingerprint: {
      primary,
      reference,
    },
  }
}

function mapHistory(
  admissions: AdmissionSummary[],
  devices: DeviceEntry[],
  admissionCache: Map<string, AdmissionDetailResponse>,
  offlineDevices: OfflineDevice[],
): HistoryRecord[] {
  return admissions
    .map((item) => mapHistoryItem(item, devices, admissionCache, offlineDevices))
    .filter((item): item is HistoryRecord => item !== null)
    .slice(0, 10)
}

function mapHistoryItem(
  admission: AdmissionSummary,
  devices: DeviceEntry[],
  admissionCache: Map<string, AdmissionDetailResponse>,
  offlineDevices: OfflineDevice[],
): HistoryRecord | null {
  const admissionId = admission.admission_id
  const shortAddr = admission.request?.short_addr
  const timestamp = admission.updated_at ?? admission.created_at

  if (!admissionId || !shortAddr || !timestamp) {
    return null
  }

  const matchedDevice = devices.find((item) => item.shortAddr === shortAddr)
  const detail = admissionCache.get(admissionId)
  const decision = normalizeAdmissionDecision(admission.decision, admission.status)
  const matchedLabel = admission.pred?.label ?? matchedDevice?.fingerprintId ?? 'unknown'
  const reference = findReferenceFingerprint(matchedLabel, offlineDevices) ?? []

  return {
    id: admissionId,
    ieeeAddr: matchedDevice?.ieeeAddr ?? '--',
    shortAddr,
    decision,
    decisionLabel: formatDecisionLabel(decision),
    matchedLabel,
    timestamp,
    latencyMs: Math.round(readNumber(admission.timing?.total_ms) ?? 0),
    reason: admission.reason ?? admission.error ?? admission.status ?? '--',
    admissionId,
    fingerprint: {
      primary: buildHeatmapsFromGaf(detail?.gaf) ?? [],
      reference,
    },
  }
}

function mapLatestAdmission(
  latestAdmission: AdmissionSummary | null,
  devices: DeviceEntry[],
  latestDetail: AdmissionDetailResponse | null,
  offlineDevices: OfflineDevice[],
): JoiningDevice {
  if (!latestAdmission?.request?.short_addr) {
    return createEmptyJoiningDevice()
  }

  const shortAddr = latestAdmission.request.short_addr
  const matchedDevice = devices.find((device) => device.shortAddr === shortAddr)
  const predictedLabel = latestAdmission.pred?.label ?? ''
  const confidence = clampNumber(latestAdmission.pred?.confidence, 0)
  const decision = normalizeAdmissionDecision(latestAdmission.decision, latestAdmission.status)

  return {
    ieeeAddr: matchedDevice?.ieeeAddr ?? '--',
    shortAddr,
    role: matchedDevice?.role ?? inferRole(latestAdmission.request.capability ?? '--', shortAddr),
    capability: latestAdmission.request.capability ?? matchedDevice?.capability ?? '--',
    joinStage: mapAdmissionStage(latestAdmission),
    predictedLabel,
    confidence,
    signalScore: Math.round(confidence * 100),
    decision,
    decisionText: formatDecisionText(decision),
    reason: latestAdmission.reason ?? latestAdmission.error ?? latestAdmission.status ?? '--',
    admissionId: latestAdmission.admission_id ?? null,
    iqSamples: {
      real: sanitizeSeries(latestDetail?.iq?.real, []),
      imag: sanitizeSeries(latestDetail?.iq?.imag, []),
    },
    fingerprint: {
      primary: buildHeatmapsFromGaf(latestDetail?.gaf) ?? [],
      reference: findReferenceFingerprint(predictedLabel, offlineDevices) ?? [],
    },
  }
}

function buildLatestAdmissionByShortAddr(admissions: AdmissionSummary[]) {
  const result = new Map<string, AdmissionSummary>()

  for (const admission of admissions) {
    const shortAddr = admission.request?.short_addr
    if (!shortAddr || result.has(shortAddr)) {
      continue
    }
    result.set(shortAddr, admission)
  }

  return result
}

function buildHeatmapsFromGaf(gaf: AdmissionDetailResponse['gaf']): FingerprintMatrix[] | null {
  const channels = normalizeGafChannels(gaf?.data, gaf?.shape)
  if (channels.length === 0) {
    return null
  }

  return channels.map((channel, index) => matrixToHeatmap(channel, getHeatmapTitle(index), '实时 GAF'))
}

function matrixToHeatmap(matrix: number[][], title: string, subtitle: string): FingerprintMatrix {
  const points: Array<[number, number, number]> = []
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY

  for (let y = 0; y < matrix.length; y += 1) {
    const row = matrix[y] ?? []
    for (let x = 0; x < row.length; x += 1) {
      const rawValue = Number(row[x] ?? 0)
      const value = Number.isFinite(rawValue) ? rawValue : 0
      min = Math.min(min, value)
      max = Math.max(max, value)
      points.push([x, y, value])
    }
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = -1
    max = 1
  } else if (min === max) {
    const padding = Math.abs(min) < 1e-6 ? 1 : Math.abs(min) * 0.1
    min -= padding
    max += padding
  }

  return {
    title,
    subtitle,
    min,
    max,
    points,
  }
}

function normalizeGafChannels(data: unknown, shape: Array<number | string> | undefined): number[][][] {
  if (!Array.isArray(data) || data.length === 0) {
    return []
  }

  const normalizedShape = normalizeTensorShape(shape)
  const [channelCount = 0, rowCount = 0, columnCount = 0] = normalizedShape
  const first = data[0]

  if (Array.isArray(first) && Array.isArray(first[0])) {
    return data
      .map((channel) => normalizeNumericMatrix(channel))
      .filter((channel): channel is number[][] => channel !== null)
  }

  if (
    channelCount > 0 &&
    rowCount > 0 &&
    columnCount > 0 &&
    data.length === channelCount &&
    Array.isArray(first) &&
    first.length === rowCount * columnCount
  ) {
    return data
      .map((channel) => reshapeFlatMatrix(channel, rowCount, columnCount))
      .filter((channel): channel is number[][] => channel !== null)
  }

  const matrix = normalizeNumericMatrix(data)
  if (matrix) {
    return [matrix]
  }

  if (
    channelCount > 0 &&
    rowCount > 0 &&
    columnCount > 0 &&
    data.length === channelCount * rowCount * columnCount
  ) {
    return reshapeFlatTensor(data, channelCount, rowCount, columnCount) ?? []
  }

  return []
}

function normalizeTensorShape(shape: Array<number | string> | undefined) {
  if (!Array.isArray(shape)) {
    return []
  }

  return shape
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0)
}

function normalizeNumericMatrix(value: unknown): number[][] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null
  }

  const rows: number[][] = []
  let columnCount: number | null = null

  for (const row of value) {
    if (!Array.isArray(row) || row.length === 0) {
      return null
    }

    if (columnCount === null) {
      columnCount = row.length
    } else if (row.length !== columnCount) {
      return null
    }

    rows.push(row.map(normalizeGafValue))
  }

  return rows
}

function reshapeFlatMatrix(value: unknown, rowCount: number, columnCount: number): number[][] | null {
  if (!Array.isArray(value) || value.length !== rowCount * columnCount) {
    return null
  }

  const rows: number[][] = []
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    rows.push(
      value
        .slice(rowIndex * columnCount, (rowIndex + 1) * columnCount)
        .map(normalizeGafValue),
    )
  }

  return rows
}

function reshapeFlatTensor(
  value: unknown[],
  channelCount: number,
  rowCount: number,
  columnCount: number,
): number[][][] | null {
  const channels: number[][][] = []
  const channelSize = rowCount * columnCount

  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const matrix = reshapeFlatMatrix(
      value.slice(channelIndex * channelSize, (channelIndex + 1) * channelSize),
      rowCount,
      columnCount,
    )
    if (!matrix) {
      return null
    }
    channels.push(matrix)
  }

  return channels
}

function normalizeGafValue(value: unknown) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : 0
}

function getHeatmapTitle(index: number) {
  if (index >= 0 && index < 26) {
    return `指纹图 ${String.fromCharCode(65 + index)}`
  }

  return `指纹图 ${index + 1}`
}

function buildReferenceHeatmaps(response: ReferenceFingerprintResponse): FingerprintMatrix[] | null {
  if (response.shape?.[0] !== 2 || response.shape?.[1] !== 256 || response.shape?.[2] !== 256) {
    return null
  }

  const channels = response.channels
  if (!Array.isArray(channels) || channels.length !== 2) {
    return null
  }

  const matrices = channels.map((channel, index) => {
    const normalizedChannel = normalizeReferenceChannel(channel)
    if (!normalizedChannel) {
      return null
    }

    return matrixToHeatmap(
      normalizedChannel,
      index === 0 ? '指纹图 A' : '指纹图 B',
      '参考指纹',
    )
  })

  return matrices.every((matrix) => matrix !== null) ? (matrices as FingerprintMatrix[]) : null
}

function normalizeReferenceChannel(channel: number[][]): number[][] | null {
  if (!Array.isArray(channel) || channel.length !== 256) {
    return null
  }

  const normalizedRows: number[][] = []
  for (const row of channel) {
    if (!Array.isArray(row) || row.length !== 256) {
      return null
    }

    normalizedRows.push(row.map((value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)))
  }

  return normalizedRows
}

function createEmptyFingerprintBundle(): FingerprintBundle {
  return {
    primary: [],
    reference: [],
  }
}

function createLiveDashboardData(): DashboardData {
  const mock = createMockDashboardData()

  return {
    ...mock,
    tick: 0,
    coordinator: {
      ...mock.coordinator,
      ieeeAddr: '--',
      panId: '--',
      channel: 0,
      permitJoinOpen: false,
      permitJoinRemaining: 0,
      pendingRequests: 0,
      deviceCount: 0,
      modelIdentifier: '--',
      networkState: 'offline',
    },
    devices: [],
    history: [],
    joiningDevice: createEmptyJoiningDevice(),
  }
}

function createEmptyJoiningDevice(): JoiningDevice {
  return {
    ieeeAddr: '--',
    shortAddr: '--',
    role: '--',
    capability: '--',
    joinStage: '暂无入网请求',
    predictedLabel: '',
    confidence: 0,
    signalScore: 0,
    decision: 'pending',
    decisionText: '待判定',
    reason: '--',
    admissionId: null,
    iqSamples: {
      real: [],
      imag: [],
    },
    fingerprint: createEmptyFingerprintBundle(),
  }
}

function normalizeDeviceStatus(status?: string | null, lastDecision?: string | null): DeviceStatus {
  const normalizedStatus = (status ?? '').toLowerCase()
  if (normalizedStatus === 'allowed') {
    return 'allowed'
  }
  if (normalizedStatus === 'denied' || normalizedStatus === 'deny_action' || lastDecision === 'deny') {
    return 'denied'
  }
  if (
    ['pending', 'pending_match', 'matched', 'associated', 'updated', 'announced'].includes(
      normalizedStatus,
    )
  ) {
    return 'pending'
  }
  if (normalizedStatus === 'offline' || normalizedStatus === 'left') {
    return 'offline'
  }
  return 'pending'
}

function normalizeDecision(value?: string | null, fallback?: string | null): DeviceDecision {
  const raw = (value ?? fallback ?? '').toLowerCase()
  if (raw.includes('deny')) {
    return 'deny'
  }
  if (
    raw.includes('pending') ||
    raw.includes('request') ||
    raw.includes('match') ||
    raw.includes('associate') ||
    raw.includes('announce')
  ) {
    return 'pending'
  }
  return 'allow'
}

function normalizeAdmissionDecision(decision?: string | null, status?: string | null): DeviceDecision {
  const normalizedDecision = (decision ?? '').toLowerCase()
  if (normalizedDecision === 'allow') {
    return 'allow'
  }
  if (normalizedDecision === 'deny') {
    return 'deny'
  }

  const normalizedStatus = (status ?? '').toLowerCase()
  if (normalizedStatus === 'timeout' || normalizedStatus === 'error') {
    return 'deny'
  }
  if (normalizedStatus === 'completed') {
    return 'allow'
  }
  return 'pending'
}

function inferRole(capability: string, shortAddr: string) {
  if (shortAddr === '0x0000') {
    return 'Coordinator'
  }
  const normalized = capability.toLowerCase()
  if (normalized === '0x8c') {
    return 'Router'
  }
  if (normalized === '0x80') {
    return 'EndDevice'
  }
  if (normalized === '0x84') {
    return 'Peer'
  }
  return 'Node'
}

function mapAdmissionStage(admission: AdmissionSummary) {
  const status = (admission.status ?? '').toLowerCase()
  const decision = (admission.decision ?? '').toLowerCase()

  switch (status) {
    case 'matched':
      return '等待推理'
    case 'completed':
      return decision === 'allow' ? '准入完成' : '拒绝入网'
    case 'timeout':
      return '匹配超时'
    case 'error':
      return '推理失败'
    default:
      return '申请入网'
  }
}

function sanitizeSeries(value: number[] | undefined, fallback: number[]) {
  if (!Array.isArray(value) || value.length === 0) {
    return fallback
  }

  return value.slice(0, 1028).map((item) => (Number.isFinite(item) ? item : 0))
}

function clampNumber(value: number | undefined | null, fallback: number) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return fallback
  }

  return Math.max(0, Math.min(1, value))
}

function readString(value: unknown) {
  return typeof value === 'string' ? value : null
}

function readNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  return null
}

function trimTrailingSlash(value: string) {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

function resolveReferenceFingerprintIeeeAddr(target: ModalTarget, offlineDevices: OfflineDevice[]) {
  if ('joinStage' in target) {
    return findOfflineDeviceByLabel(target.predictedLabel, offlineDevices)?.ieeeAddr ?? null
  }

  if ('fingerprintId' in target) {
    return (
      findOfflineDeviceByLabel(target.fingerprintId, offlineDevices)?.ieeeAddr ??
      (target.ieeeAddr !== '--' ? target.ieeeAddr : null)
    )
  }

  return findOfflineDeviceByLabel(target.matchedLabel, offlineDevices)?.ieeeAddr ?? null
}

function findReferenceFingerprint(label: string, offlineDevices: OfflineDevice[]) {
  if (!label) {
    return null
  }

  return findOfflineDeviceByLabel(label, offlineDevices)?.fingerprint ?? null
}

function findOfflineDeviceByLabel(label: string, offlineDevices: OfflineDevice[]) {
  if (!label) {
    return null
  }

  return offlineDevices.find((device) => device.label === label) ?? null
}

function clampPollInterval(value: number) {
  if (!Number.isFinite(value)) {
    return 3000
  }

  return Math.max(1000, Math.min(30000, Math.round(value)))
}

function formatDecisionLabel(decision: DeviceDecision) {
  return decision === 'allow' ? '准许' : decision === 'deny' ? '拒绝' : '待决策'
}

function formatDecisionText(decision: DeviceDecision) {
  return decision === 'allow' ? '允许入网' : decision === 'deny' ? '拒绝入网' : '待判定'
}
