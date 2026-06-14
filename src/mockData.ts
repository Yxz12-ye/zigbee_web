import type {
  ComparisonItem,
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

const BASE_TIME = new Date('2026-05-24T20:12:00+08:00').getTime()

const DEVICE_CATALOG = [
  {
    label: 'device_0',
    ieeeAddr: 'f0:f5:bd:ff:fe:02:f3:28',
    shortAddr: '0x4A28',
    role: 'Router',
    capability: '0x8C',
    family: 'Router / 常驻节点',
    tags: ['稳定', '低漂移'],
    seed: 12,
  },
  {
    label: 'device_1',
    ieeeAddr: '98:a3:16:ff:fe:9e:d4:6c',
    shortAddr: '0x9A15',
    role: 'EndDevice',
    capability: '0x80',
    family: 'EndDevice / 低功耗',
    tags: ['灵敏', '轻漂移'],
    seed: 21,
  },
  {
    label: 'device_2',
    ieeeAddr: 'ac:eb:e6:ff:fe:c2:23:6c',
    shortAddr: '0xBCB7',
    role: 'Router',
    capability: '0x8C',
    family: 'Router / 高负载',
    tags: ['密集', '高置信'],
    seed: 33,
  },
  {
    label: 'device_3',
    ieeeAddr: 'ac:eb:e6:ff:fe:c0:bf:a8',
    shortAddr: '0xC4F1',
    role: 'Coordinator Peer',
    capability: '0x84',
    family: 'Peer / 对照节点',
    tags: ['锐利', '集中'],
    seed: 44,
  },
] as const

export function createMockDashboardData(): DashboardData {
  const devices = DEVICE_CATALOG.map((entry, index) => createDeviceEntry(entry, index))
  const history = buildHistory(0)

  return {
    tick: 0,
    coordinator: {
      ieeeAddr: '00:12:4b:00:1c:b6:a5:f7',
      panId: '0x1A3C',
      channel: 15,
      permitJoinOpen: true,
      permitJoinRemaining: 345,
      decisionMode: 'http-callback',
      pendingRequests: 1,
      deviceCount: devices.length + 7,
      modelIdentifier: 'RF_FINGERPRINT_ZC',
      networkState: 'formed',
    },
    devices,
    joiningDevice: createJoiningDevice(0),
    history,
    offlineDevices: DEVICE_CATALOG.map((entry, index) => createOfflineDevice(entry, index)),
    comparison: buildComparison(),
  }
}

export function tickDashboardData(previous: DashboardData): DashboardData {
  const nextTick = previous.tick + 1
  const joiningDevice = createJoiningDevice(nextTick)
  const history = buildHistory(nextTick)
  const devices = previous.devices.map((device, index) => {
    const swing = ((nextTick + index) % 5) - 2
    const confidence = clamp(device.matchedConfidence + swing * 0.01, 0.78, 0.99)
    const signalScore = clamp(device.signalScore + swing * 2, 68, 97)
    const status: DeviceStatus =
      device.ieeeAddr === joiningDevice.ieeeAddr
        ? 'pending'
        : device.status === 'offline'
          ? 'offline'
          : 'allowed'
    const lastDecision: DeviceDecision =
      device.ieeeAddr === joiningDevice.ieeeAddr
        ? 'pending'
        : device.lastDecision === 'deny'
          ? 'deny'
          : 'allow'

    return {
      ...device,
      matchedConfidence: roundTo(confidence, 2),
      signalScore,
      lastSeenAt: isoOffset(nextTick * 5 + index * 3),
      status,
      lastDecision,
    }
  })

  return {
    ...previous,
    tick: nextTick,
    devices,
    joiningDevice,
    history,
    offlineDevices: previous.offlineDevices.map((device, index) => ({
      ...device,
      similarity: roundTo(clamp(device.similarity + (((nextTick + index) % 4) - 1.5) * 0.01, 0.77, 0.98), 2),
      lastUpdated: isoOffset(nextTick * 4 + index * 11),
    })),
    coordinator: {
      ...previous.coordinator,
      permitJoinRemaining: Math.max(40, 345 - nextTick * 3),
      pendingRequests: nextTick % 3 === 0 ? 2 : 1,
      deviceCount: previous.coordinator.deviceCount + (nextTick % 5 === 0 ? 1 : 0),
    },
  }
}

export function exportFingerprintSnapshot(target: { fingerprint: FingerprintBundle; ieeeAddr: string }) {
  const payload = {
    ieeeAddr: target.ieeeAddr,
    exportedAt: new Date().toISOString(),
    fingerprint: target.fingerprint,
  }

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${target.ieeeAddr.replace(/:/g, '-')}-fingerprint.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

function createDeviceEntry(
  entry: (typeof DEVICE_CATALOG)[number],
  index: number,
): DeviceEntry {
  return {
    ieeeAddr: entry.ieeeAddr,
    shortAddr: entry.shortAddr,
    role: entry.role,
    capability: entry.capability,
    status: index === 1 ? 'pending' : index === 3 ? 'offline' : 'allowed',
    lastDecision: index === 2 ? 'deny' : 'allow',
    lastSeenAt: isoOffset(index * 7),
    fingerprintId: entry.label,
    signalScore: 72 + index * 5,
    matchedConfidence: roundTo(0.81 + index * 0.035, 2),
    parentShort: index === 0 ? '0x0000' : '0x4A28',
    admissionId: null,
    fingerprint: createFingerprintBundle(entry.seed, entry.label),
  }
}

function createJoiningDevice(tick: number): JoiningDevice {
  const entry = DEVICE_CATALOG[tick % DEVICE_CATALOG.length]
  const confidence = roundTo(0.88 + (tick % 4) * 0.02, 2)
  const decision: DeviceDecision = tick % 4 === 3 ? 'deny' : tick % 4 === 2 ? 'allow' : 'pending'

  return {
    ieeeAddr: entry.ieeeAddr,
    shortAddr: entry.shortAddr,
    role: entry.role,
    capability: entry.capability,
    joinStage: ['申请入网', '等待判定', '同步指纹', '回传结果'][tick % 4],
    predictedLabel: entry.label,
    confidence,
    signalScore: 78 + ((tick + 1) % 5) * 4,
    decision,
    decisionText: decision === 'allow' ? '允许入网' : decision === 'deny' ? '拒绝入网' : '待判定',
    reason: decision === 'deny' ? 'predicted_unknown' : decision === 'allow' ? 'recognized_known_label' : 'matching',
    admissionId: null,
    iqSamples: createIqSamples(entry.seed + tick),
    fingerprint: createFingerprintBundle(entry.seed + tick, entry.label),
  }
}

function createOfflineDevice(
  entry: (typeof DEVICE_CATALOG)[number],
  index: number,
): OfflineDevice {
  return {
    label: entry.label,
    ieeeAddr: entry.ieeeAddr,
    family: entry.family,
    similarity: roundTo(0.84 + index * 0.03, 2),
    lastUpdated: isoOffset(index * 13),
      tags: [...entry.tags],
    fingerprint: [
      createHeatmap(`${entry.label}-known-a`, entry.seed + 1, '指纹图 A'),
      createHeatmap(`${entry.label}-known-b`, entry.seed + 4, '指纹图 B'),
    ],
  }
}

function buildHistory(tick: number): HistoryRecord[] {
  return Array.from({ length: 10 }, (_, index) => {
    const entry = DEVICE_CATALOG[(tick + index) % DEVICE_CATALOG.length]
    const decision = index % 4 === 1 ? 'deny' : index % 5 === 3 ? 'pending' : 'allow'

    return {
      id: tick * 10 + index + 1,
      ieeeAddr: entry.ieeeAddr,
      shortAddr: entry.shortAddr,
      decision,
      decisionLabel: decision === 'allow' ? '准许' : decision === 'deny' ? '拒绝' : '待决策',
      matchedLabel: entry.label,
      timestamp: isoOffset(tick * 5 + index * 9),
      latencyMs: 118 + ((tick + index) % 5) * 27,
      admissionId: null,
      reason:
        decision === 'allow'
          ? 'match_known_device'
          : decision === 'deny'
            ? 'confidence_below_threshold'
            : 'waiting_model_response',
      fingerprint: createFingerprintBundle(entry.seed + tick + index, entry.label),
    }
  })
}

function buildComparison(): ComparisonItem[] {
  const left = DEVICE_CATALOG[0]
  const right = DEVICE_CATALOG[2]

  return [
    {
      leftLabel: left.label,
      leftIeeeAddr: left.ieeeAddr,
      leftFingerprint: [
        createHeatmap(`${left.label}-cmp-a`, left.seed + 7, '指纹图 A'),
        createHeatmap(`${left.label}-cmp-b`, left.seed + 14, '指纹图 B'),
      ],
      rightLabel: right.label,
      rightIeeeAddr: right.ieeeAddr,
      rightFingerprint: [
        createHeatmap(`${right.label}-cmp-a`, right.seed + 7, '指纹图 A'),
        createHeatmap(`${right.label}-cmp-b`, right.seed + 14, '指纹图 B'),
      ],
    },
  ]
}

function createFingerprintBundle(seed: number, label: string): FingerprintBundle {
  return {
    primary: [
      createHeatmap(`${label}-primary-a`, seed + 1, '当前样本 A'),
      createHeatmap(`${label}-primary-b`, seed + 5, '当前样本 B'),
    ],
    reference: [
      createHeatmap(`${label}-reference-a`, seed + 2, '参考样本 A'),
      createHeatmap(`${label}-reference-b`, seed + 8, '参考样本 B'),
    ],
  }
}

function createIqSamples(seed: number) {
  const total = 128
  const real: number[] = []
  const imag: number[] = []

  for (let index = 0; index < total; index += 1) {
    const phase = (index / total) * Math.PI * 3.4
    const drift = seed * 0.07
    real.push(roundTo(Math.sin(phase + drift) * 0.76 + Math.cos(phase * 0.4) * 0.24, 3))
    imag.push(roundTo(Math.cos(phase * 1.12 - drift) * 0.68 + Math.sin(phase * 0.3) * 0.19, 3))
  }

  return { real, imag }
}

function createHeatmap(key: string, seed: number, title: string): FingerprintMatrix {
  const size = 24
  const points: Array<[number, number, number]> = []

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const centerX = (seed % 8) + 6 + Math.sin(seed * 0.2) * 2
      const centerY = ((seed * 3) % 10) + 7
      const dx = x - centerX
      const dy = y - centerY
      const ring = Math.sin((x + seed) * 0.32) * Math.cos((y - seed) * 0.21)
      const gaussian = Math.exp(-(dx * dx + dy * dy) / (48 + (seed % 5) * 5))
      const ridge = Math.exp(-Math.abs(dx - dy) / (6 + (seed % 4)))
      const value = clamp((gaussian * 0.72 + ridge * 0.18 + (ring + 1) * 0.05) * 100, 0, 100)
      points.push([x, y, roundTo(value, 2)])
    }
  }

  return {
    title,
    subtitle: key.replaceAll('-', ' · '),
    min: 0,
    max: 100,
    points,
  }
}

function isoOffset(secondsAgo: number) {
  return new Date(BASE_TIME - secondsAgo * 1000).toISOString()
}

function roundTo(value: number, precision: number) {
  const factor = 10 ** precision
  return Math.round(value * factor) / factor
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
