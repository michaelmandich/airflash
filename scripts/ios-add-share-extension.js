#!/usr/bin/env node
/**
 * Adds the ShareExtension target to ios/App/App.xcodeproj/project.pbxproj so the share
 * sheet target lives in git and never has to be clicked together in Xcode.
 *
 *   node scripts/ios-add-share-extension.js
 *
 * Idempotent: if a native target named ShareExtension already exists it only re-runs the
 * checks. The three extension files are expected in ios/App/ShareExtension/.
 *
 * UNVERIFIED until CI builds it: the xcode npm package (3.0.1) has not been validated against
 * Capacitor 8's pbxproj (objectVersion 60, SPM package references). docs/ios-build-plan.md
 * section 3a marks this route [uncertain]; if the macOS workflow fails on the extension,
 * fall back to the manual Xcode steps in docs/ios-mac-setup.md (appendix).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const xcode = require('xcode');
const PbxFile = require('xcode/lib/pbxFile');

const ROOT = path.resolve(__dirname, '..');
const PBXPROJ = path.join(ROOT, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
const TARGET = 'ShareExtension';
const BUNDLE_ID = 'app.airflash.ios.share';
const EMBED_PHASE = 'Embed App Extensions';
const SOURCE_DIR = path.join(ROOT, 'ios', 'App', TARGET);
const FILES = ['ShareViewController.swift', 'Info.plist', 'ShareExtension.entitlements'];

function unquote(value) {
  return typeof value === 'string' ? value.replace(/^"(.*)"$/, '$1') : value;
}

function entries(section) {
  return Object.entries(section || {}).filter(([key]) => !key.endsWith('_comment'));
}

function findNativeTarget(proj, name) {
  for (const [uuid, target] of entries(proj.pbxNativeTargetSection())) {
    if (unquote(target.name) === name) return { uuid, target };
  }
  return null;
}

function configsOf(proj, target) {
  const list = proj.pbxXCConfigurationList()[target.buildConfigurationList];
  return list.buildConfigurations.map(({ value }) => proj.pbxXCBuildConfigurationSection()[value]);
}

// The parser turns "0920" into the number 920; put the original strings back.
function preserveToolVersions(proj, original) {
  const attributes = proj.getFirstProject().firstProject.attributes;
  for (const key of ['LastSwiftUpdateCheck', 'LastUpgradeCheck']) {
    const match = original.match(new RegExp(`${key} = ([^;]+);`));
    if (match) attributes[key] = match[1];
  }
}

// pbxProject.addFile() refuses any path that already exists anywhere in the project
// ("Info.plist" collides with the app's), so register references directly.
function addReference(proj, groupKey, fileName, opt) {
  const file = new PbxFile(fileName, opt);
  file.fileRef = proj.generateUuid();
  proj.addToPbxFileReferenceSection(file);
  proj.addToPbxGroup(file, groupKey);
  return file;
}

function createTarget(proj, app) {
  const objects = proj.hash.project.objects;
  // addTargetDependency() silently does nothing when these sections are missing.
  objects.PBXTargetDependency = objects.PBXTargetDependency || {};
  objects.PBXContainerItemProxy = objects.PBXContainerItemProxy || {};

  const created = proj.addTarget(TARGET, 'app_extension', TARGET, BUNDLE_ID);
  const uuid = created.uuid;
  const target = proj.pbxNativeTargetSection()[uuid];

  // addTarget quotes the name; plain identifiers are what Xcode writes.
  target.name = TARGET;
  target.productName = TARGET;
  proj.pbxNativeTargetSection()[`${uuid}_comment`] = TARGET;
  for (const entry of proj.getFirstProject().firstProject.targets) {
    if (entry.value === uuid) entry.comment = TARGET;
  }

  proj.addBuildPhase([], 'PBXSourcesBuildPhase', 'Sources', uuid);
  proj.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', uuid);
  proj.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', uuid);

  const group = proj.addPbxGroup([], TARGET, TARGET);
  proj.addToPbxGroup(group.uuid, proj.getFirstProject().firstProject.mainGroup);

  const swift = addReference(proj, group.uuid, 'ShareViewController.swift');
  swift.target = uuid;
  swift.uuid = proj.generateUuid();
  proj.addToPbxBuildFileSection(swift);
  proj.addToPbxSourcesBuildPhase(swift);
  // Reference only: INFOPLIST_FILE points at it; it must not be copied as a resource.
  addReference(proj, group.uuid, 'Info.plist');
  addReference(proj, group.uuid, 'ShareExtension.entitlements', { lastKnownFileType: 'text.plist.entitlements' });

  const appSettings = configsOf(proj, app.target)[0].buildSettings;
  for (const config of configsOf(proj, target)) {
    Object.assign(config.buildSettings, {
      PRODUCT_BUNDLE_IDENTIFIER: BUNDLE_ID,
      PRODUCT_NAME: '"$(TARGET_NAME)"',
      INFOPLIST_FILE: `${TARGET}/Info.plist`,
      GENERATE_INFOPLIST_FILE: 'NO',
      CODE_SIGN_ENTITLEMENTS: `${TARGET}/ShareExtension.entitlements`,
      CODE_SIGN_STYLE: 'Automatic',
      IPHONEOS_DEPLOYMENT_TARGET: '16.0',
      SWIFT_VERSION: '5.0',
      TARGETED_DEVICE_FAMILY: '"1,2"',
      SKIP_INSTALL: 'YES',
      CURRENT_PROJECT_VERSION: appSettings.CURRENT_PROJECT_VERSION || '1',
      MARKETING_VERSION: appSettings.MARKETING_VERSION || '1.0',
      LD_RUNPATH_SEARCH_PATHS: '"$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks"',
    });
    if (config.name === 'Debug') config.buildSettings.SWIFT_ACTIVE_COMPILATION_CONDITIONS = 'DEBUG';
  }

  proj.addTargetAttribute('CreatedOnToolsVersion', '26.0', created);
  proj.addTargetAttribute('ProvisioningStyle', 'Automatic', created);

  return { uuid, target };
}

// addTarget() wires the dependency before we unquote the target name; tidy the comments.
function tidyDependencyComments(proj, ext) {
  const objects = proj.hash.project.objects;
  for (const [, dep] of entries(objects.PBXTargetDependency)) {
    if (dep.target === ext.uuid) dep.target_comment = TARGET;
  }
  for (const [, proxy] of entries(objects.PBXContainerItemProxy)) {
    if (proxy.remoteGlobalIDString === ext.uuid) proxy.remoteInfo = TARGET;
  }
}

function ensureDependency(proj, app, ext) {
  const deps = proj.hash.project.objects.PBXTargetDependency || {};
  const has = (app.target.dependencies || []).some(({ value }) => deps[value] && deps[value].target === ext.uuid);
  if (!has) proj.addTargetDependency(app.uuid, [ext.uuid]);
  return !has;
}

function ensureEmbedPhase(proj, app, ext) {
  const objects = proj.hash.project.objects;
  const phases = objects.PBXCopyFilesBuildPhase || (objects.PBXCopyFilesBuildPhase = {});
  const buildFiles = proj.pbxBuildFileSection();
  const appex = `${TARGET}.appex`;

  let phaseUuid = null;
  for (const { value } of app.target.buildPhases) {
    const phase = phases[value];
    if (phase && phase.dstSubfolderSpec === 13) phaseUuid = value; // 13 = PlugIns
  }
  if (!phaseUuid) {
    phaseUuid = proj.addBuildPhase([], 'PBXCopyFilesBuildPhase', EMBED_PHASE, app.uuid, 'app_extension').uuid;
  }
  const phase = phases[phaseUuid];
  phase.name = `"${EMBED_PHASE}"`;
  phases[`${phaseUuid}_comment`] = EMBED_PHASE;
  for (const entry of app.target.buildPhases) {
    if (entry.value === phaseUuid) entry.comment = EMBED_PHASE;
  }

  let buildFileUuid = phase.files.map(({ value }) => value)
    .find((uuid) => buildFiles[uuid] && buildFiles[uuid].fileRef === ext.target.productReference);
  if (!buildFileUuid) {
    buildFileUuid = proj.generateUuid();
    buildFiles[buildFileUuid] = { isa: 'PBXBuildFile', fileRef: ext.target.productReference, fileRef_comment: appex };
    phase.files.push({ value: buildFileUuid });
  }
  buildFiles[buildFileUuid].settings = { ATTRIBUTES: ['RemoveHeadersOnCopy'] };
  buildFiles[`${buildFileUuid}_comment`] = `${appex} in ${EMBED_PHASE}`;
  for (const entry of phase.files) {
    if (entry.value === buildFileUuid) entry.comment = `${appex} in ${EMBED_PHASE}`;
  }
}

function verify(filePath) {
  const proj = xcode.project(filePath);
  proj.parseSync();
  const problems = [];
  const targets = entries(proj.pbxNativeTargetSection()).filter(([, t]) => unquote(t.name) === TARGET);
  if (targets.length !== 1) problems.push(`expected exactly one ${TARGET} target, found ${targets.length}`);
  const app = findNativeTarget(proj, 'App');
  const ext = targets[0] && { uuid: targets[0][0], target: targets[0][1] };
  if (!app) problems.push('App target not found');
  if (app && ext) {
    const deps = proj.hash.project.objects.PBXTargetDependency || {};
    if (!(app.target.dependencies || []).some(({ value }) => deps[value] && deps[value].target === ext.uuid)) {
      problems.push('App does not depend on ShareExtension');
    }
    const phases = proj.hash.project.objects.PBXCopyFilesBuildPhase || {};
    const buildFiles = proj.pbxBuildFileSection();
    const embedded = app.target.buildPhases.some(({ value }) => {
      const phase = phases[value];
      return phase && phase.dstSubfolderSpec === 13 &&
        phase.files.some((f) => buildFiles[f.value] && buildFiles[f.value].fileRef === ext.target.productReference);
    });
    if (!embedded) problems.push('App has no PlugIns copy phase containing ShareExtension.appex');
    const sources = proj.hash.project.objects.PBXSourcesBuildPhase || {};
    const refs = proj.pbxFileReferenceSection();
    const compilesSwift = ext.target.buildPhases.some(({ value }) => {
      const phase = sources[value];
      return phase && phase.files.some((f) => {
        const bf = buildFiles[f.value];
        return bf && refs[bf.fileRef] && unquote(refs[bf.fileRef].path) === 'ShareViewController.swift';
      });
    });
    if (!compilesSwift) problems.push('ShareExtension does not compile ShareViewController.swift');
    for (const config of configsOf(proj, ext.target)) {
      if (unquote(config.buildSettings.PRODUCT_BUNDLE_IDENTIFIER) !== BUNDLE_ID) problems.push(`${config.name}: wrong bundle id`);
      if (unquote(config.buildSettings.INFOPLIST_FILE) !== `${TARGET}/Info.plist`) problems.push(`${config.name}: wrong INFOPLIST_FILE`);
    }
  }
  return problems;
}

function main() {
  for (const name of FILES) {
    if (!fs.existsSync(path.join(SOURCE_DIR, name))) throw new Error(`missing ${path.join(SOURCE_DIR, name)}`);
  }
  const original = fs.readFileSync(PBXPROJ, 'utf8');
  const proj = xcode.project(PBXPROJ);
  proj.parseSync();
  preserveToolVersions(proj, original);

  const app = findNativeTarget(proj, 'App');
  if (!app) throw new Error('App target not found in project.pbxproj');
  if (proj.getFirstTarget().uuid !== app.uuid) throw new Error('App is not the first target; addTarget() would embed into the wrong one');

  let ext = findNativeTarget(proj, TARGET);
  let changed = false;
  if (ext) {
    console.log(`${TARGET} target already present (${ext.uuid})`);
  } else {
    ext = createTarget(proj, app);
    changed = true;
    console.log(`added ${TARGET} target ${ext.uuid}`);
  }
  if (ensureDependency(proj, app, ext)) {
    changed = true;
    console.log('added App -> ShareExtension dependency');
  }
  tidyDependencyComments(proj, ext);
  const before = JSON.stringify(proj.hash.project.objects.PBXCopyFilesBuildPhase || {});
  ensureEmbedPhase(proj, app, ext);
  if (JSON.stringify(proj.hash.project.objects.PBXCopyFilesBuildPhase) !== before) {
    changed = true;
    console.log(`ensured "${EMBED_PHASE}" phase on App`);
  }

  if (changed) {
    // omitEmptyValues: otherwise unset pbxFile fields are written as the literal word "undefined"
    fs.writeFileSync(PBXPROJ, proj.writeSync({ omitEmptyValues: true }));
    console.log(`wrote ${path.relative(ROOT, PBXPROJ)}`);
  } else {
    console.log('no changes needed');
  }

  const problems = verify(PBXPROJ);
  if (problems.length) {
    console.error('verification failed:\n - ' + problems.join('\n - '));
    process.exit(1);
  }
  console.log('verified: one ShareExtension target, App depends on it and embeds ShareExtension.appex under PlugIns');
}

main();
