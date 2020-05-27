export interface OptimizerChargingProfilesRequest {
  state: OptimizerState;
  event: OptimizerEvent;
  verbosity?: number;
}

export interface OptimizerChargingProfilesResponse {
  cars?: OptimizerCar[];
}

export interface OptimizerState {
  currentTimeSeconds: number;
  fuseTree?: OptimizerFuseTree;
  chargingStations?: OptimizerChargingStationConnectorFuse[];
  maximumSiteLimitKW?: number;
  cars: OptimizerCar[];
  energyPriceHistory?: OptimizerEnergyPriceHistory;
  carAssignments: OptimizerCarConnectorAssignment[];
}

export interface OptimizerEvent {
  carID?: number;
  chargingStationID?: number;
  energyPriceHistory?: OptimizerEnergyPriceHistory;
  eventType: OptimizerEventType;
}

export interface OptimizerCar {
  id: number;
  name?: string;
  modelName?: string;
  carType: OptimizerCarType;
  startCapacity?: number;
  timestampArrival: number;
  timestampDeparture?: number;
  maxCapacity: number;
  minCurrent: number;
  minCurrentPerPhase: number;
  maxCurrent: number;
  maxCurrentPerPhase: number;
  suspendable?: boolean;
  canUseVariablePower?: boolean;
  immediateStart?: boolean;
  minLoadingState?: number;
  canLoadPhase1?: number;
  canLoadPhase2?: number;
  canLoadPhase3?: number;
  currentPlan?: number[];
  chargingStarted?: boolean;
  chargedCapacity?: number;
}

export interface OptimizerFuseTree {
  rootFuse: OptimizerFuse;
  numberChargingStationsBottomLevel?: number;
}

export interface OptimizerEnergyPriceHistory {
  energyPrices?: number[];
  date?: string;
}

export interface OptimizerCarConnectorAssignment {
  carID: number;
  chargingStationID: number; // It's a connector but for the optimizer this is a Charging Station
}

export interface OptimizerFuseTreeNode {
  '@type': 'Fuse' | 'ChargingStation';
  id?: number;
  phase1Connected?: boolean;
  phase2Connected?: boolean;
  phase3Connected?: boolean;
  children?: OptimizerFuseTreeNode[];
}

export interface ConnectorPower {
  numberOfConnectedPhase: number;
  totalAmps: number;
}

export interface OptimizerFuse extends OptimizerFuseTreeNode {
  '@type': 'Fuse';
  id: number;
  fusePhase1: number;
  fusePhase2: number;
  fusePhase3: number;
  children: OptimizerChargingStationFuse[];
}

export interface OptimizerChargingStationFuse extends OptimizerFuseTreeNode {
  '@type': 'Fuse'; // For the optimizer
  id: number;
  fusePhase1?: number;
  fusePhase2?: number;
  fusePhase3?: number;
  phaseToGrid?: { [P in OptimizerPhase]?: OptimizerPhase };
  phaseToChargingStation?: { [P in OptimizerPhase]?: OptimizerPhase };
  isBEVAllowed?: boolean;
  isPHEVAllowed?: boolean;
  status?: OptimizerStationStatus;
}

export interface OptimizerChargingStationConnectorFuse extends OptimizerFuseTreeNode {
  '@type': 'ChargingStation'; // For the optimizer
  id: number;
  fusePhase1?: number;
  fusePhase2?: number;
  fusePhase3?: number;
  phaseToGrid?: { [P in OptimizerPhase]?: OptimizerPhase };
  phaseToChargingStation?: { [P in OptimizerPhase]?: OptimizerPhase };
  isBEVAllowed?: boolean;
  isPHEVAllowed?: boolean;
  status?: OptimizerStationStatus;
}

export interface OptimizerResult {
  cars: OptimizerCar[];
}

export type OptimizerEventType = 'CarArrival' | 'CarDeparture' | 'CarFinished' | 'EnergyPriceChange' | 'Reoptimize';

export type OptimizerCarType = 'BEV' | 'PHEV' | 'PETROL' | 'DIESEL';

export type OptimizerPhase = 'PHASE_1' | 'PHASE_2' | 'PHASE_3';

export type OptimizerStationStatus = 'Free' | 'Charging' | 'Reserved' | 'Blocked' | 'Maintenance' | 'Disconnected';

export type OptimizerFuseTreeNodeUnion = OptimizerFuse | OptimizerChargingStationConnectorFuse;
