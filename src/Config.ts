/**
 * Loads values from VS Code config. It is currently only read at extension launch,
 * but config change watchers can be added here if needed.
 */

import * as vscode from 'vscode';

const hackConfig = vscode.workspace.getConfiguration('hack');

export const clientPath: string = hackConfig.get('clientPath') || 'hh_client';
export const hhClientArgs: string[] = clientPath.split(' ');
export const hhClientCommand: string = String(hhClientArgs.shift());

export let mapWorkspace: boolean = false;
export let workspace: string;
const workspaceRootPath: string | undefined = hackConfig.get('workspaceRootPath');
if (workspaceRootPath) {
    mapWorkspace = true;
    workspace = workspaceRootPath;
} else if (vscode.workspace.workspaceFolders) {
    workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
}

let enableCoverageCheckConfig: boolean | undefined = hackConfig.get('enableConverageCheck');
if (enableCoverageCheckConfig === undefined) {
    enableCoverageCheckConfig = true;
}
export const enableCoverageCheck: boolean = enableCoverageCheckConfig;

let useLanguageServerConfig: boolean | undefined = hackConfig.get('useLanguageServer');
if (useLanguageServerConfig === undefined) {
    useLanguageServerConfig = true;
}
export const useLanguageServer: boolean = useLanguageServerConfig;

export const useHhast: boolean = hackConfig.get('useHhast') || false;

export const hhastLintMode: 'whole-project' | 'open-files' | undefined | null = hackConfig.get('hhastLintMode');

export const hhastPath: string | undefined = hackConfig.get('hhastPath');
export const hhastArgs: string[] = hackConfig.get('hhastArgs') || [];

// Use the global configuration so that a project can't both provide a malicious hhast-lint executable and whitelist itself in $project/.vscode/settings.json
const hhastRemembered: { globalValue?: { [key: string]: 'trusted' | 'untrusted' } } | undefined = hackConfig.inspect('hhastRememberedWorkspaces');
export const hhastRememberedWorkspaces: { [key: string]: 'trusted' | 'untrusted' } = hhastRemembered ? (hhastRemembered.globalValue || {}) : {}

export async function rememberHhastWorkspace(workspace: string, trust: 'trusted' | 'untrusted') {
    let remembered = hhastRememberedWorkspaces;
    remembered[workspace] = trust;
    await hackConfig.update('hhastRememberedWorkspaces', remembered, vscode.ConfigurationTarget.Global);
}
