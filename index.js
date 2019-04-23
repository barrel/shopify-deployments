#! /usr/bin/env node

console.log('testing');

/**
 * @author Barrelny.com
 * @updated 3/31/2019
 *
 * This script looks into all liquid snippets and checks
 * to see if all assigned variables have been nullified.
 *
 * Skips templates, sections and theme files.
 * Ignores variables prefixes with 'global_'
 *
 * Needs:
 * - Build and deploy using Barrel CLI
 * - Back up existing theme by duplicating it
 */
const themeKit = require('@shopify/themekit')
const brrl = require('@barrelny/cli/ci')
const {exec} = require('child_process')
const request = require('request-promise')
const yaml = require('js-yaml')
const fs = require('fs')
const moment = require('moment')

const CONFIG_ENV = process.env.CONFIG_ENV || 'production'
const STAGE = process.env.STAGE || 'backup'
const IS_QUICK_TEST = process.env.IS_QUICK_TEST || false

// This should be a theme ID
const BASE_THEME = process.env.BASE_THEME || false

const config = (
  fs.existsSync('./config.yml')
  ? yaml.safeLoad(
    fs.readFileSync('./config.yml', 'utf8')
  )[CONFIG_ENV]
  : ({
    'api_key': process.env.SHOPIFY_API_KEY,
    'password': process.env.SHOPIFY_PASSWORD,
    'store': process.env.SHOPIFY_STORE
  })
)

const TMP_DIR = `${process.cwd()}/tmp`

Promise.all([
  /**
   * Here, we handle the tmp directory that we'll
   * use to download the 'base' theme into. This 'base'
   * theme becomes either the backup or the base of the
   * new change updates that are on the current branch.
   */
  new Promise((resolve, reject) => {
    console.log('Removing existing tmp directory')
    if (fs.existsSync(TMP_DIR) && !IS_QUICK_TEST) {
      exec(`rm -r ${TMP_DIR}`, (err, stdout, stderr) => {
        if (err) {
          reject(err)
        }
        resolve(true)
      })
    } else {
      resolve(true)
    }
  }).then(() => {
    if (!IS_QUICK_TEST) {
      fs.mkdirSync(TMP_DIR)
    }

    return Promise.resolve(process.chdir(TMP_DIR))
  }),

  /**
   * Here, we get the name of the active branch
   * so that we can decide whether we nee to duplicate
   * the active theme or not, or remove old themes if there
   * are 20 themes active
   */
  new Promise((resolve, reject) => {
    console.log('Getting current branch')
    exec('git branch', (err, stdout, stderr) => {
      if (err) {
        reject(err)
      }

      const active = stdout
        .split('\n')
        .reduce((found, branch) => {
          if (found) {
            return found
          }

          if (~branch.indexOf('*')) {
            return branch.replace('* ', '').trim()
          }
        }, false)

      resolve(active)
    })
  }),

  /**
   * Here, we get all of the themes for the current
   * store. Mainly, we use this to see if there are already 20
   * themes and if so, we'll need to start deleting themes
   * to make room for a new backup
   */
  request({
    uri: `https://${config['store']}/admin/themes.json`,
    headers: {
      'Authorization': `Basic ${Buffer.from(config['api_key'] + ':' + config['password']).toString('base64')}`
    }
  }).then(response => {
    console.log('Existing themes fetched')
    const decoded = JSON.parse(response)
    const {themes = []} = decoded
    themes.sort((a, b) => {
      return new Date(b.updated_at) - new Date(a.updated_at)
    })
    return Promise.resolve(themes)
  })
])
.then(([changeDirSuccess, branch, themes]) => {
  const gitBase = /develop/.test(branch) ? 'master' : 'develop'

  /**
   * Here, we get all of the commits on the current
   * branch. We do this so we can see if there is already
   * a staging theme for this branch.
   */
  return new Promise((resolve, reject) => {
    console.log(`Running 'git fetch --all'`)
    exec(`git fetch --all`, (err, stdout, stderr) => {
      if (err) {
        reject(err)
      }
      
      console.log(`git 'cherry -v ${gitBase}'`)
      exec(`git cherry -v ${gitBase}`, (err, stdout, stderr) => {
        const commits = stdout
          .split('\n')
          .map(commit => (
            commit.replace(/[+-] ?/, '').trim()
          ))
          .filter(commit => commit)

        resolve([changeDirSuccess, branch, themes, commits])
      })
    })
  })
})
.then(([changeDirSuccess, branch, themes, commits]) => {
  console.log('Running main routine')
  /**
   * If the current branch is a feature, bugfix
   * or hotfix branch, we need to look for an existing
   * theme to deploy to. If an existing theme does not
   * exist, then we'll need to create a new theme off of
   * current live theme. If the live theme is a DEV theme,
   * then we'll look for the most recent unpublished
   * STAGE or LIVE theme and use that as a base.
   */
  /**
   * If the current branch is develop, then we need to
   * check for a STAGE branch made in the last week
   * since the last merge. If this theme exists, then
   * deploy to it. If it doesn't, then create a new theme
   * off of the current live theme and immediately deploy
   * to it
   */
  if (/feature|hotfix|bugfix|develop/i.test(branch)) {
    // https://stackoverflow.com/questions/14848274/git-log-to-get-commits-only-for-a-specific-branch
    return isAlreadyDeployedThemeForBranch(themes, branch, commits, /develop/.test(branch))
      .then(existingTheme => {
        if (existingTheme) {
          console.log('Existing base found!'.blue)
          console.log(`Theme Name: ${existingTheme.name}`.blue)
          return Promise.resolve(existingTheme.id)
        }
        console.log('No existing base found'.blue)
        return duplicateCurrentBase(themes)
      }).then(themeID => {
        return buildAndDeploy(themeID)
      })
  }

  /**
   * If the current branch is the master branch,
   * duplicate the live theme to make a backup,
   * OR (depending on ENV flag) deploy to the live
   * theme.
   */
  if (/master/i.test(branch) && STAGE === 'backup') {
    return duplicateCurrentBase(themes, true)
  }

  if (/master/i.test(branch) && STAGE === 'deploy') {
    return getBase(themes, true).then(themeID => {
      return buildAndDeploy(themeID)
    })
  }
}).then(() => {
  if (IS_QUICK_TEST) {
    return Promise.resolve(true)
  }
  console.log('Removing tmp directory')
  return new Promise((resolve, reject) => {
    exec(`rm -r ${TMP_DIR}`, (err, stdout, stderr) => {
      if (err) {
        reject(err)
      }
      resolve(true)
    })
  })
})

function isAlreadyDeployedThemeForBranch (themes = [], branch, commits = [], noLessThan7DaysOld = false) {
  const foundTheme = themes.reduce((isFound, {name, ...theme}) => {
    let [env = 'DEV', commit = ''] = name.split(' - ')

    if (isFound) {
      return isFound
    }

    if (~commit.indexOf('(')) {
      commit = commit.match(/.*[(](.*)[)]/)[1]
    }

    if (!/staging|stage/i.test(env)) {
      return false
    }

    // If there is a theme that contains a commit
    // on this branch in it's name..
    if (!commits.find(str => ~str.indexOf(commit))) {
      return false
    }

    if (noLessThan7DaysOld) {
      const themeDate = moment(theme['updated_at'])
      if (themeDate.isBefore(moment().subtract('7', 'Days'))) {
        return false
      }
    }

    return {
      name,
      ...theme
    }
  }, false)

  return Promise.resolve(foundTheme)
}

function duplicateCurrentBase (themes = [], forcePublished = false) {
  return getBase(themes, forcePublished)
    .then(theme => {
      return downloadTheme(theme)
    }).then(() => {
      return uploadBaseToNewTheme()
    })
}

function getBase (themes = [], forcePublished = false) {
  const publishedTheme = themes.find(theme => theme.role === 'main')
  const [env = 'DEV'] = publishedTheme.name.split(' - ')

  if (BASE_THEME) {
    return themes.find(({id}) => '' + id === '' + BASE_THEME)
  }

  if (forcePublished) {
    return Promise.resolve(publishedTheme)
  }

  // If the published theme is not a dev theme, then
  // use this as the base
  if (/(live|stage)/i.test(env)) {
    return Promise.resolve(publishedTheme)
  }

  const unpublishedBase = themes.find(theme => {
    const [_env = 'DEV'] = theme.name.split(' - ')
    if (/(live|stage)/i.test(_env)) {
      return theme
    }
    return false
  })

  if (!unpublishedBase) {
    console.log('No base theme could be found. Duplication not possible.')
    process.exit()
  }

  return Promise.resolve(unpublishedBase)
}

function downloadTheme (theme) {
  if (IS_QUICK_TEST) {
    return Promise.resolve(true)
  }

  console.log(`Downloading theme`.blue)
  console.log(`Theme Name: ${theme.name}`.blue)
  return themeKit.command('download', {
    password: config['password'],
    store: config['store'],
    themeId: theme.id
  }).catch(() => {
    throw new Error('Themekit download failed')
  })
}

function uploadBaseToNewTheme () {
  return (
    IS_QUICK_TEST
    ? Promise.resolve(true)
    : (
      console.log(`Uploading new theme!`.blue),
      themeKit.command('new', {
        password: config['password'],
        store: config['store'],
        name: '[DEPLOYMENT IN PROGRESS]'
      })
    )
  ).then(() => {
    return Promise.resolve(
      yaml.safeLoad(
        fs.readFileSync(`${TMP_DIR}/config.yml`, 'utf8')
      )['development']['theme_id']
    )
  })
}

function buildAndDeploy (themeId) {
  process.chdir(`${TMP_DIR}/..`)
  return brrl({
    shouldLoadConfig: false,
    defaults: {
      'theme_id': themeId,
      'api_key': config['api_key'],
      'password': config['password'],
      'store': config['store']
    }
  })
}
