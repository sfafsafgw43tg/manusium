# Optional Windows registry integration

The installer exposes two **unchecked-by-default** options:

- **Open `octobrowser://` links with Octo.su**: registers the per-user URI protocol under `HKCU\Software\Classes\octobrowser`.
- **Register optional Octo.su Windows integration**: associates `.octoprofile` files with Octo.su through the per-user `OctoSuite.Profile` ProgID.

These entries improve normal Windows integration only: links and explicitly exported profile files can open in Octo.su, and the installed icon is shown for those items. They do not change browser fingerprint behavior, privacy settings, security policy, or profile storage.

## Safety and ownership

- Registration is **per-user** (`HKCU`) and does not require administrator access.
- The installer stores only rollback metadata (previous registry values, key names, and an expected app-owned value) in `registry-state.ini` beside the installed program. It never stores passwords, cookies, history, session contents, profile data, or fingerprint data in the registry or rollback file.
- On upgrade, the previous app-owned values are restored before applying the new task selection. This makes unchecking an option an opt-out operation.
- On uninstall, a value is restored only when its current contents still exactly match the value written by OctoSuite. If the user or another program changed it, the installer leaves it untouched and logs the normal installer result rather than overwriting it.
- Empty integration keys are removed only when Windows reports that they have no remaining values or subkeys. Unrelated values prevent key deletion.
- Malformed or missing rollback state is treated as no-op; it cannot cause deletion of unrelated keys.
- The application data directory is outside the install directory and is not removed by the uninstaller.

## Explicitly excluded

The project does **not** copy another browser's registry profile, hide forensic evidence, disable Windows security controls, bypass policy, tamper with Defender/UAC, or imitate another product's installation identity. Those behaviors would not improve ordinary browser safety and could weaken the host system.

## Testing

The repository test checks the installer source for unchecked tasks, HKCU-only integration, rollback guards, and the absence of sensitive registry fields. Actual registry writes should be exercised on a disposable Windows VM with install, upgrade, opt-out, uninstall, and a user-modified-value rollback case.
