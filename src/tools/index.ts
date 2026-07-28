import type { ToolDef } from './common';
import { getDesignContext } from './read/getDesignContext';
import { getMetadata } from './read/getMetadata';
import { getScreenshot } from './read/getScreenshot';
import { downloadAssets } from './read/downloadAssets';
import { getVariableDefs } from './read/getVariableDefs';
import { searchDesignSystem } from './read/searchDesignSystem';
import { getCodeConnectMap } from './read/getCodeConnectMap';
import { whoami } from './read/whoami';
import { getHtmlReplicaSpec } from './replica/getHtmlReplicaSpec';
import { renderHtmlScreenshot } from './replica/renderHtmlScreenshot';
import { verifyHtmlParity } from './replica/verifyHtmlParity';
import { compareHtmlToImage } from './replica/compareHtmlToImage';
import { bridgeStatus } from './write/bridgeStatus';
import { executePluginCommand } from './write/executePluginCommand';
import { importHtmlReplica } from './write/importHtmlReplica';

export const readTools: ToolDef[] = [
  getDesignContext,
  getMetadata,
  getScreenshot,
  downloadAssets,
  getVariableDefs,
  searchDesignSystem,
  getCodeConnectMap,
  whoami,
];

export const replicaTools: ToolDef[] = [getHtmlReplicaSpec, renderHtmlScreenshot, verifyHtmlParity, compareHtmlToImage];

export const writeTools: ToolDef[] = [bridgeStatus, executePluginCommand, importHtmlReplica];

export const allTools: ToolDef[] = [...readTools, ...replicaTools, ...writeTools];
