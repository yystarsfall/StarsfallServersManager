import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Activation', () => {
  test('extension activates and registers commands', async () => {
    const ext = vscode.extensions.getExtension('starsfall.starsfall-servers-manager'); // 用你真实的 publisher.name
    assert.ok(ext, 'extension not found');
    await ext!.activate();

    const commands = await vscode.commands.getCommands(true);
    const expected = [
      'starsfall.connectServer',
      'starsfall.editServer',
      'starsfall.removeServer',
      'starsfall.disconnectAll'
    ];
    for (const cmd of expected) assert.ok(commands.includes(cmd), `missing command: ${cmd}`);
  });
  test('commands execute without error', async () => {
    await vscode.commands.executeCommand('starsfall.focusServersExplorer');
    await vscode.commands.executeCommand('starsfall.disconnectAll');
  });
});