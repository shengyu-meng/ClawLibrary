export type ResourcePartitionId =
  | 'document'
  | 'images'
  | 'memory'
  | 'skills'
  | 'gateway'
  | 'log'
  | 'mcp'
  | 'schedule'
  | 'alarm'
  | 'agent'
  | 'task_queues'
  | 'break_room';

export type Point = { x: number; y: number };

export type WalkNode = {
  id: string;
  x: number;
  y: number;
  roomId: ResourcePartitionId;
};

export type WalkGraph = {
  nodes: WalkNode[];
  edges: [string, string][];
};

export type RoomBounds = {
  id: ResourcePartitionId;
  label: string;
  bounds: [number, number, number, number];
  labelAnchor?: Point;
};

export type CollisionPolygon = {
  id: string;
  points: Point[];
};

export type OccluderRect = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WorkZoneType = ResourcePartitionId;

export type WorkZone = {
  id: ResourcePartitionId;
  label: string;
  roomId: ResourcePartitionId;
  type: WorkZoneType;
  anchor: Point;
  radius: number;
};

export type RenderLayerId = 'floor' | 'back_walls' | 'mid_props' | 'actor' | 'fg_occluder' | 'fx_overlay';

export type RenderLayerDef = {
  id: RenderLayerId;
  depth: number;
};

export type WalkableZone = {
  id: string;
  points: Point[];
};

export type MapLogic = {
  meta: {
    version: string;
    baseResolution: { width: number; height: number };
    schema: string;
  };
  renderLayers?: RenderLayerDef[];
  rooms: RoomBounds[];
  walkableZones?: WalkableZone[];
  walkGraph: WalkGraph;
  collisionPolygons: CollisionPolygon[];
  occluders: OccluderRect[];
  workZones: WorkZone[];
};

export type AssetKind = 'book' | 'tool' | 'art' | 'marker';

export type AssetLayer = 'ground' | 'mid' | 'fg_occluder' | RenderLayerId;

export type BoxRect = [number, number, number, number];

export type AssetStateVariants = Partial<Record<'idle' | 'active' | 'grown' | 'alert', string>>;

export type AssetDef = {
  id: string;
  kind: AssetKind;
  roomId: ResourcePartitionId;
  layer: AssetLayer;
  assetKey?: string;
  anchor: Point;
  footpoint?: Point;
  size: { width: number; height: number };
  displaySize?: { width: number; height: number };
  occupancyBox?: BoxRect;
  visibleBBox?: BoxRect;
  depthBand?: number;
  hitPolygon: Point[];
  stateVariants?: AssetStateVariants;
  startsHidden?: boolean;
};

export type GrowthRule = {
  metric: 'assetsCount' | 'skillsCount' | 'textOutputs';
  threshold: number;
  reveal: string[];
};

export type AssetManifest = {
  meta: {
    version: string;
    schema: string;
  };
  assets: AssetDef[];
  growthRules: GrowthRule[];
};

export type ThemePack = {
  meta: {
    version: string;
    schema: string;
    topologyHash: string;
  };
  themes: {
    id: string;
    label: string;
    tint: number;
    roomFill: number;
    roomStroke: number;
  }[];
};

export type GrowthState = {
  assetsCount: number;
  skillsCount: number;
  textOutputs: number;
};

export type TextureAssetKind = 'image' | 'svg' | 'spritesheet';

export type TextureAssetRef = {
  textureKey: string;
  path: string;
  kind?: TextureAssetKind;
  frameWidth?: number;
  frameHeight?: number;
  frameCount?: number;
  margin?: number;
  spacing?: number;
};

export type RoomSliceLayerDef = TextureAssetRef & {
  id: string;
  renderLayer: RenderLayerId;
  anchor: Point;
  displaySize: { width: number; height: number };
  alpha?: number;
  tintWithTheme?: boolean;
};

export type SceneGlobalLayerDef = TextureAssetRef & {
  id: string;
  renderLayer: RenderLayerId;
  anchor: Point;
  displaySize: { width: number; height: number };
  alpha?: number;
  tintWithTheme?: boolean;
};

export type RoomArtSlice = {
  id: string;
  roomId: ResourcePartitionId;
  replacesLayers: RenderLayerId[];
  layers: RoomSliceLayerDef[];
};

export type WorkMode = 'idle' | 'moving' | 'working';

export type ActorVisualMode = TextureAssetRef & {
  mode: WorkMode;
  stateIds?: LobsterStateId[];
  animation?: {
    fps: number;
    repeat?: number;
  };
};

export type ActorVariantDef = {
  id: string;
  label: string;
  modes: ActorVisualMode[];
};

export type ActorVisualDef = {
  id: string;
  displaySize: { width: number; height: number };
  anchorOffset?: Point;
  shadow?: {
    width: number;
    height: number;
    offsetY: number;
    alpha: number;
  };
  modes?: ActorVisualMode[];
  defaultVariantId?: string;
  variants?: ActorVariantDef[];
};

export type SceneArtManifest = {
  meta: {
    version: string;
    schema: string;
  };
  globalLayers?: SceneGlobalLayerDef[];
  roomSlices: RoomArtSlice[];
  actor?: ActorVisualDef;
  conceptRefs?: Array<{
    id: string;
    path: string;
    prompt?: string;
  }>;
};

export type LobsterStateId =
  | 'idle'
  | 'writing'
  | 'cataloging'
  | 'documenting'
  | 'syncing'
  | 'monitoring'
  | 'researching'
  | 'executing'
  | 'error'
  | 'resting';

export type OutputCategoryId = ResourcePartitionId;

export type InterfaceId = ResourcePartitionId;

export type OutputCategoryDef = {
  id: OutputCategoryId;
  label: string;
  summary: string;
  sampleContents: string[];
};

export type InterfaceDef = {
  id: InterfaceId;
  label: string;
  endpoint: string;
  status: 'online' | 'degraded' | 'offline';
};

export type WorkStateProfile = {
  id: LobsterStateId;
  label: string;
  zoneTypes: WorkZoneType[];
  interfaceIds: InterfaceId[];
  outputCategoryIds: OutputCategoryId[];
  detailTemplates: string[];
};

export type WorkOutputProtocol = {
  meta: {
    version: string;
    schema: string;
  };
  outputCategories: OutputCategoryDef[];
  interfaces: InterfaceDef[];
  states: WorkStateProfile[];
};

export type WorkOutputEvent = {
  stateId: LobsterStateId;
  stateLabel: string;
  outputCategoryId: OutputCategoryId;
  outputCategoryLabel: string;
  interfaceId: InterfaceId;
  interfaceLabel: string;
  interfaceEndpoint: string;
  content: string;
};

export type WorkStatus = {
  mode: WorkMode;
  zone: string | null;
  stateId: LobsterStateId;
  stateLabel: string;
  outputCategory: string;
  interfaceTarget: string;
  detail: string;
};

export type ResourceTelemetryStatus = 'idle' | 'active' | 'alert' | 'offline';

export type OpenClawResourceTelemetry = {
  id: ResourcePartitionId;
  label: string;
  status: ResourceTelemetryStatus;
  itemCount: number;
  lastAccessAt: string | null;
  summary: string;
  detail: string;
  source: string;
  items?: OpenClawResourceItem[];
};

export type OpenClawResourceItem = {
  id: string;
  title: string;
  path: string;
  updatedAt: string | null;
  sizeBytes?: number;
  meta?: string;
  openPath?: string;
  folderPath?: string;
  excerpt?: string;
  thumbnailPath?: string;
  stats?: Array<{
    label: string;
    value: string;
    tone?: string;
  }>;
};

export type OpenClawAccessEvent = {
  id: string;
  resourceId: ResourcePartitionId;
  label: string;
  occurredAt: string;
  detail: string;
  status: ResourceTelemetryStatus;
  source: string;
};

export type OpenClawFocus = {
  resourceId: ResourcePartitionId;
  label: string;
  occurredAt: string | null;
  detail: string;
  reason: string;
};

export type ActiveAgent = {
  id: string;
  label: string;
  status: string;
};

export type ActiveExecProcess = {
  id: string;
  label: string;
  command: string;
  status: 'running' | 'completed' | 'failed';
};

export type MainActorContext = {
  /** Current context token count for the active main-agent session */
  tokens: number;
  /** Inferred max context window for the active model */
  maxTokens: number;
  /** Remaining fraction 0–1 (1 = full, 0 = exhausted) */
  remaining: number;
};

export type OpenClawSnapshot = {
  mode: 'live' | 'mock';
  generatedAt: string;
  resources: OpenClawResourceTelemetry[];
  recentEvents: OpenClawAccessEvent[];
  focus: OpenClawFocus;
  activeAgents?: ActiveAgent[];
  activeProcesses?: ActiveExecProcess[];
  mainActorContext?: MainActorContext;
};
