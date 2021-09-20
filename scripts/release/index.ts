import { CAC } from 'cac';
import fs from 'fs-extra';
import path from 'path';
import jsonfile from 'jsonfile';
import enquirer from 'enquirer';
import semver from 'semver';
import consola from 'consola';
import execa from 'execa';
import chalk from 'chalk';

import { selectSingleProject } from '../utils/select-project';
import { allPackages } from '../utils/packages';
import { readWorkspacePackagesWithVersion } from '../utils/read-packages';

// 不需要CHANGELOG
// yarn cli release
// -> 选择 package
// -> 选择 release type
// -> bump version
// -> collect deps
// -> (optinal)bump dep workspace package version
// -> nx build --with-deps
// git add packages/PACKAGE (--dry-run --verbose)
// git-cz --type release --scope PACKAGE --non-interactive --subject release PACKAGE Version xxx
// git tag
// git push
// git push --tags
// yarn cli release PACKAGE --minor

const enum ReleaseType {
  MAJOR = 'major',
  MINOR = 'minor',
  PATCH = 'patch',
  PREMAJOR = 'premajor',
  PREMINOR = 'preminor',
  PREPATCH = 'prepatch',
}

const RELEASE_TYPES: ReleaseType[] = [
  ReleaseType.MAJOR,
  ReleaseType.MINOR,
  ReleaseType.PATCH,
];

export interface ReleaseCLIOptions {
  type: ReleaseType;
  dryRun: boolean;
  version?: string;
  yes: boolean;
  skipGit: boolean;
}

export default function useReleaseProject(cli: CAC) {
  cli
    .command('release [name]', 'Release project', {
      allowUnknownOptions: true,
    })
    .option('--type', 'Choose release type', {
      default: ReleaseType.PATCH,
    })
    .option('--version [version]', 'Use custom version instead semver bump')
    .option('--skip-git', 'Skip git add & commit & push', {
      default: false,
    })
    // .option('--yes', 'Skip confirm prompt', {
    //   default: false,
    // })
    // .option('--no-yes', 'Donnot skip confirm prompt')
    .option('--dry-run', 'Use dry run mode', {
      default: false,
    })

    .alias('r')
    .action(async (name: string, options: ReleaseCLIOptions) => {
      try {
        const projectToRelease =
          name ??
          (await selectSingleProject([], 'Choose a project to release'));

        if (!allPackages.includes(projectToRelease)) {
          consola.error(
            `Oops, it seems that project ${chalk.cyan(
              projectToRelease
            )} does not exist.`
          );
          process.exit(1);
        }

        const { dryRun, version, skipGit } = options;

        const packagesInfo = readWorkspacePackagesWithVersion();

        const projectCurrentVersion = packagesInfo.find(
          (info) => info.project === projectToRelease
        )!.version;

        const releaseVersion =
          version ??
          (
            (await enquirer.prompt({
              type: 'select',
              name: 'version',
              message: 'Select release type',
              choices: RELEASE_TYPES.map(
                (incType) =>
                  `${incType} (${incredVersion(
                    projectCurrentVersion,
                    incType
                  )})`
              ),
            })) as { version: string }
          ).version.match(/\((.*)\)/)![1];

        if (!semver.valid(releaseVersion)) {
          consola.error(
            `Invalid target version: ${chalk.yellow(releaseVersion)}`
          );
          process.exit(1);
        }

        const releaseTag = `${projectToRelease}@${releaseVersion}`;

        consola.info(`Release Tag: ${chalk.cyan(releaseTag)}`);

        const { yes }: Record<'yes', string> = await enquirer.prompt({
          type: 'confirm',
          name: 'yes',
          message: `Releasing ${releaseTag}. Confirm?`,
          initial: true,
        });

        if (!yes) {
          consola.info(`Release ${releaseTag} canceled.`);
          process.exit(0);
        } else {
          consola.info(`Releasing ${releaseTag}...`);
        }

        const projectDir = path.join(
          process.cwd(),
          'packages',
          projectToRelease
        );

        const projectPkgPath = path.join(projectDir, 'package.json');
        const pkgInfo = jsonfile.readFileSync(projectPkgPath);

        pkgInfo.version = releaseVersion;

        if (!dryRun) {
          fs.writeFileSync(
            projectPkgPath,
            JSON.stringify(pkgInfo, null, 2) + '\n'
          );
        }

        dryRunInfoLogger(
          `${projectToRelease} version updated to ${releaseVersion}`,
          dryRun
        );

        consola.info('Building packages...');

        !dryRun &&
          (await execa('nx', ['build', projectToRelease, '--verbose'], {
            cwd: process.cwd(),
            preferLocal: true,
            stdio: 'inherit',
          }));

        dryRunSuccessLogger(
          `Package ${projectToRelease} built successfully.`,
          dryRun
        );

        const { stdout } = await execa('git', ['diff'], { stdio: 'pipe' });

        if (!stdout) {
          consola.error('No commit changes found, exist.');
          process.exit(0);
        }

        if (!skipGit) {
          dryRunInfoLogger('Committing changes...', dryRun);

          await execa(
            'git',
            ['add', `packages/${projectToRelease}`, '--verbose'].concat(
              dryRun ? ['--dry-run'] : []
            ),
            {
              stdio: 'inherit',
            }
          );

          const gitCZCommandArgs = [
            '--type=release',
            `--scope=${projectToRelease.split('-')[0]}`,
            `--subject=Release ${releaseTag}`,
            '--non-interactive',
          ];

          !dryRun
            ? await execa('git-cz', gitCZCommandArgs, {
                stdio: 'inherit',
                preferLocal: true,
              })
            : consola.info(
                `${chalk.white('DRY RUN MODE')}: Executing >>> ${chalk.cyan(
                  `git-cz ${gitCZCommandArgs.join(' ')}`
                )}`
              );

          !dryRun
            ? await execa('git', ['tag', releaseTag], {
                stdio: 'inherit',
              })
            : consola.info(
                `${chalk.white('DRY RUN MODE')}: Executing >>> ${chalk.cyan(
                  `git tag ${releaseTag}`
                )}`
              );

          await execa(
            'git',
            [
              'push',
              'origin',
              `refs/tags/${releaseTag}`,
              '--verbose',
              '--progress',
            ].concat(dryRun ? ['--dry-run'] : []),
            {
              stdio: 'inherit',
            }
          );

          await execa(
            'git',
            ['push', '--verbose', '--progress'].concat(
              dryRun ? ['--dry-run'] : []
            ),
            {
              stdio: 'inherit',
            }
          );
        } else {
          consola.warn('Remember you have skipped git process.');
        }

        dryRunInfoLogger('Pubishing package...', dryRun);

        const { stdout: logAs } = await execa('npm', ['whoami'], {
          cwd: projectDir,
          stdio: 'pipe',
          shell: true,
          preferLocal: true,
        });

        consola.info(`You're now logged as ${chalk.bold(chalk.white(logAs))}`);

        await execa(
          'npm',
          ['publish', '--access=public'].concat(dryRun ? ['--dry-run'] : []),
          {
            cwd: projectDir,
            stdio: 'inherit',
            shell: true,
            preferLocal: true,
          }
        );

        dryRunSuccessLogger('Package published', dryRun);
      } catch (error) {
        consola.error(error);
      }
    });
}

export const incredVersion = (currentVer: string, type: ReleaseType) =>
  semver.inc(currentVer, type);

export const dryRunInfoLogger = (msg: string, dryRun: boolean) =>
  dryRun
    ? consola.info(`${chalk.white('DRY RUN MODE')}: ${msg}`)
    : consola.info(msg);

export const dryRunSuccessLogger = (msg: string, dryRun: boolean) =>
  dryRun
    ? consola.success(`${chalk.white('DRY RUN MODE')}: ${msg}`)
    : consola.info(msg);
