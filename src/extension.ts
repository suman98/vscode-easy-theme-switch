import * as vscode from 'vscode';

let log: vscode.OutputChannel;

interface ActionItem extends vscode.QuickPickItem {
    action: 'add' | 'remove';
}

interface ThemeItem extends vscode.QuickPickItem {
    value: string;
}

interface ThemeEntry {
    value: string; // the value workbench.colorTheme expects (id, else label)
    label: string; // human-readable display name
}

/**
 * All installed color themes. `workbench.colorTheme` expects the theme `id`
 * when a theme declares one, otherwise the `label`. `ext.packageJSON` is
 * already nls-resolved, so `label` is the display string (e.g.
 * "Dark (Visual Studio)") while `id` is the stable value ("Visual Studio Dark").
 */
function getThemeEntries(): ThemeEntry[] {
    const entries: ThemeEntry[] = [];
    const seen = new Set<string>();
    for (const ext of vscode.extensions.all) {
        const themes = ext.packageJSON?.contributes?.themes;
        if (!themes) continue;
        for (const theme of themes) {
            const value = theme.id ?? theme.label;
            const label = theme.label ?? theme.id;
            if (value && !seen.has(value)) {
                seen.add(value);
                entries.push({ value, label });
            }
        }
    }
    entries.sort((a, b) => a.label.localeCompare(b.label));
    return entries;
}

function getCurrentTheme(): string {
    return vscode.workspace.getConfiguration('workbench').get<string>('colorTheme') ?? '';
}

async function applyTheme(value: string): Promise<void> {
    try {
        await vscode.workspace.getConfiguration('workbench').update(
            'colorTheme',
            value,
            vscode.ConfigurationTarget.Global
        );
        log.appendLine(`applyTheme "${value}" -> now "${getCurrentTheme()}"`);
        // The setting accepts any string, but VS Code only renders a theme it
        // can resolve. Detect values that are not a known installed theme.
        const known = getThemeEntries().some(e => e.value === value);
        if (!known) {
            vscode.window.showWarningMessage(
                `Theme Picker: "${value}" is not a recognized theme id. It won't render.`
            );
        }
    } catch (err) {
        log.appendLine(`applyTheme FAILED: ${err}`);
        vscode.window.showErrorMessage(`Theme Picker: failed to apply "${value}": ${err}`);
    }
}

function getFavorites(context: vscode.ExtensionContext): string[] {
    return context.globalState.get<string[]>('themePicker.favorites') ?? [];
}

async function saveFavorites(context: vscode.ExtensionContext, favorites: string[]): Promise<void> {
    await context.globalState.update('themePicker.favorites', favorites);
}

/**
 * Older builds stored favorites by display label. Remap any such entries to
 * the canonical theme value so they actually apply.
 */
async function migrateFavorites(context: vscode.ExtensionContext): Promise<void> {
    const favorites = getFavorites(context);
    if (favorites.length === 0) return;

    const entries = getThemeEntries();
    const values = new Set(entries.map(e => e.value));
    const valueByLabel = new Map(entries.map(e => [e.label, e.value]));

    let changed = false;
    const migrated = favorites.map(fav => {
        if (values.has(fav)) return fav;          // already canonical
        const value = valueByLabel.get(fav);      // stored as display label
        if (value) {
            changed = true;
            return value;
        }
        return fav;                               // unknown, leave as-is
    });

    if (changed) {
        await saveFavorites(context, [...new Set(migrated)]);
        log.appendLine('migrated favorites label -> value');
    }
}

async function addThemesFlow(context: vscode.ExtensionContext): Promise<void> {
    const entries = getThemeEntries();
    const favorites = new Set(getFavorites(context));
    const available = entries.filter(e => !favorites.has(e.value));

    if (available.length === 0) {
        vscode.window.showInformationMessage('All installed themes are already in your library.');
        return;
    }

    const picks = await vscode.window.showQuickPick<ThemeItem>(
        available.map(e => ({ label: e.label, value: e.value })),
        {
            title: 'Add to Library',
            placeHolder: 'Select themes to add (multi-select with Space)',
            canPickMany: true,
        }
    );

    if (picks === undefined) {
        return;
    }
    if (picks.length === 0) {
        vscode.window.showInformationMessage('No themes selected. Use Space to check themes, then Enter to confirm.');
        return;
    }
    const newFavorites = [...new Set([...favorites, ...picks.map(p => p.value)])];
    await saveFavorites(context, newFavorites);
    vscode.window.showInformationMessage(`Added ${picks.length} theme(s) to your library.`);
}

async function removeThemesFlow(context: vscode.ExtensionContext): Promise<void> {
    const favorites = getFavorites(context);

    if (favorites.length === 0) {
        vscode.window.showInformationMessage('Your theme library is empty.');
        return;
    }

    const labelByValue = new Map(getThemeEntries().map(e => [e.value, e.label]));
    const picks = await vscode.window.showQuickPick<ThemeItem>(
        favorites.map(value => ({ label: labelByValue.get(value) ?? value, value })),
        {
            title: 'Remove from Library',
            placeHolder: 'Select themes to remove (multi-select with Space)',
            canPickMany: true,
        }
    );

    if (picks?.length) {
        const toRemove = new Set(picks.map(p => p.value));
        await saveFavorites(context, favorites.filter(v => !toRemove.has(v)));
        vscode.window.showInformationMessage(`Removed ${picks.length} theme(s) from your library.`);
    }
}

function refreshPickerBtn(btn: vscode.StatusBarItem): void {
    const value = getCurrentTheme();
    const label = getThemeEntries().find(e => e.value === value)?.label ?? value;
    btn.text = '$(symbol-color)';
    btn.tooltip = label ? `Theme: ${label} — click to change` : 'Open theme picker';
}

export function activate(context: vscode.ExtensionContext) {
    log = vscode.window.createOutputChannel('Theme Picker');
    log.appendLine('=== Theme Picker activated ===');

    void migrateFavorites(context);

    // Status bar: theme picker
    const pickerBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    pickerBtn.command = 'themePicker.pick';
    refreshPickerBtn(pickerBtn);
    pickerBtn.show();

    // Status bar: settings
    const settingsBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    settingsBtn.text = '$(settings-gear)';
    settingsBtn.tooltip = 'Manage theme library';
    settingsBtn.command = 'themePicker.settings';
    settingsBtn.show();

    const configListener = vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('workbench.colorTheme')) {
            refreshPickerBtn(pickerBtn);
        }
    });

    const pickCmd = vscode.commands.registerCommand('themePicker.pick', async () => {
        const favorites = getFavorites(context);

        if (favorites.length === 0) {
            const action = await vscode.window.showInformationMessage(
                'Your theme library is empty.',
                'Add Themes'
            );
            if (action === 'Add Themes') {
                vscode.commands.executeCommand('themePicker.settings');
            }
            return;
        }

        const originalTheme = getCurrentTheme();
        let accepted = false;

        const addButton: vscode.QuickInputButton = {
            iconPath: new vscode.ThemeIcon('add'),
            tooltip: 'Add themes to library',
        };
        const removeButton: vscode.QuickInputButton = {
            iconPath: new vscode.ThemeIcon('trash'),
            tooltip: 'Remove from library',
        };

        const buildItems = (): ThemeItem[] => {
            const labelByValue = new Map(getThemeEntries().map(e => [e.value, e.label]));
            const current = getCurrentTheme();
            return getFavorites(context).map(value => ({
                label: labelByValue.get(value) ?? value,
                value,
                description: value === current ? '● active' : undefined,
                buttons: [removeButton],
            }));
        };

        const qp = vscode.window.createQuickPick<ThemeItem>();
        qp.title = 'Theme Picker';
        qp.placeholder = 'Select a theme to apply';
        qp.buttons = [addButton];
        qp.items = buildItems();

        // Pre-select the active theme
        const activeItem = qp.items.find(i => i.value === originalTheme);
        if (activeItem) {
            qp.activeItems = [activeItem];
        }

        // Live preview as user navigates
        qp.onDidChangeActive(async (active) => {
            if (active[0]) {
                await applyTheme(active[0].value);
            }
        });

        // Header add button: restore original theme, then open the add flow.
        qp.onDidTriggerButton(async (button) => {
            if (button === addButton) {
                qp.hide(); // accepted is false -> onDidHide restores original
                await addThemesFlow(context);
            }
        });

        // Per-row trash button: remove that favorite and refresh in place.
        qp.onDidTriggerItemButton(async (e) => {
            if (e.button !== removeButton) return;
            const favorites = getFavorites(context).filter(v => v !== e.item.value);
            await saveFavorites(context, favorites);
            if (favorites.length === 0) {
                qp.hide();
                vscode.window.showInformationMessage('Your theme library is now empty.');
                return;
            }
            qp.items = buildItems();
        });

        qp.onDidAccept(async () => {
            const selected = qp.selectedItems[0] ?? qp.activeItems[0];
            accepted = true;
            qp.hide();
            if (selected) {
                await applyTheme(selected.value);
            }
        });

        // Restore original theme on cancel
        qp.onDidHide(async () => {
            if (!accepted) {
                await applyTheme(originalTheme);
            }
            qp.dispose();
        });

        qp.show();
    });

    const settingsCmd = vscode.commands.registerCommand('themePicker.settings', async () => {
        const actionItems: ActionItem[] = [
            { label: '$(add) Add themes to library', action: 'add' },
            { label: '$(trash) Remove themes from library', action: 'remove' },
        ];

        const choice = await vscode.window.showQuickPick<ActionItem>(actionItems, {
            title: 'Theme Library',
            placeHolder: 'What would you like to do?',
        });

        if (!choice) return;

        if (choice.action === 'add') {
            await addThemesFlow(context);
        } else {
            await removeThemesFlow(context);
        }
    });

    context.subscriptions.push(log, pickerBtn, settingsBtn, pickCmd, settingsCmd, configListener);
}

export function deactivate() {}
