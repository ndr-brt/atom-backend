/**
 * @module vcs
 * @desc This Module is intended to be the platform agnostic tool to interaction
 * with Version Control Systems of different types in the cloud.
 * To collect data from them, format it accordingly ang return it to the requesting
 * function.
 */

const query = require("./query.js");
const utils = require("./utils.js");
const GitHub = require("./vcs_providers/github.js");
const semVerInitRegex = /^\s*v/i;

/**
 * @async
 * @function ownership
 * @desc Allows the ability to check if a user has permissions to write to a repo.
 * <b>MUST</b> be provided the full `user` and `package` objects here to account
 * for possible situations. This allows any new handling that's needed to be defined
 * here rather than in multiple locations throughout the codebase.
 * Returns `ok: true` where content is the repo data from the service provider on
 * success, returns `ok: false` if they do not have access to said repo, with
 * specificity available within the `short` key.
 * @param {object} userObj - The Full User Object, as returned by the backend,
 * and appended to with authorization data.
 * @param {object|string} packObj - The full Package objects data from the backend.
 * Although, can also contain a string, this string would directly be
 * an Owner/Repo combo, but it is recommended to use the Package Object when
 * possible. The string variant is intended to be used when first publishing
 * a package, and there is no package object to use.
 * @param {object} [opts] - An optional configuration object, that allows the
 * definition of non-standard options to change the fucntionality of this function.
 * `opts` can accept the following parameters:
 *  - dev_override: {boolean} - Wether to enable or disable the dev_override. Disabled
 *    by default, this dangerous boolean is inteded to be used during tests that
 *    overrides the default safe static returns, and lets the function run as intended
 *    in development mode.
 * @returns {object} - A Server Status object containing the role of the user according
 * to the repo or otherwise a failure.
 */
async function ownership(userObj, packObj, dev_override = false) {
  // TODO: Ideally we don't have any static fake returns.
  // As we have seen this degrades the accuracy of our tests greatly.
  // Now that we have the whole new Testing System I'd like to move away and remove this
  // code whole sale, as well as the `dev_override`. But in the interest in finishing
  // up this PR, and merging before I become to far off from main, we can keep this system for now.
  // And hopefully rely on our individual vcs tests.
  if (
    process.env.PULSAR_STATUS === "dev" &&
    !dev_override &&
    process.env.MOCK_GH !== "false"
  ) {
    console.log(
      `git.js.ownership() Is returning Dev Only Permissions for ${userObj.username}`
    );

    switch (userObj.username) {
      case "admin_user":
        return { ok: true, content: "admin" };
      case "no_perm_user":
        return {
          ok: false,
          content: "Development NoPerms User",
          short: "No Repo Access",
        };
      default:
        return {
          ok: false,
          content: "Server in Dev Mode passed unhandled user",
          short: "Server Error",
        };
    }
  }
  // Non-dev return.

  // Since the package is already on the DB when attempting to determine ownership
  // (Or is at least formatted correctly, as if it was) We can directly access the
  // repository object provided by determineProvider

  // Below we check for object because if packObj is an object then we were given
  // a full packages object, and we need to extract an owner/repo combo.
  // But if we were passed a string then we instead would use it directly.
  // Since a string should only be passed when there was no package object
  // to provide such as during package publish.
  // Which if we are getting a string, then we will fallback to the default
  // which is GitHub, which will work for now.
  const repoObj =
    typeof packObj === "object" ? packObj.repository.type : packObj;
  // TODO: Double check validity of Object, but we should have `.type` & `.url`

  switch (repoObj) {
    // Additional supported VCS systems go here.
    case "git":
    default: {
      const github = new GitHub();

      // Here we check if we were handed an owner/repo combo directly by checking
      // for a string. Otherwise we assume it's a package object where we need to
      // find the owner/repo combo.
      const ownerRepo =
        typeof packObj === "string"
          ? packObj
          : utils.getOwnerRepoFromPackage(packObj);

      const owner = await github.ownership(userObj, ownerRepo);
      // ^^^ Above we pass the full package object since github will decode
      // the owner/repo combo as needed.
      return owner;
    }
  }
}

/**
 * @async
 * @function newPackageData
 * @desc Replaces the previous git.createPackage().
 * Intended to retreive the full packages data. The data which will contain
 * all information needed to create a new package entry onto the DB.
 * @param {object} userObj - The Full User Object as returned by auth.verifyAuth()
 * @param {string} ownerRepo - The Owner Repo Combo for the package such as `pulsar-edit/pulsar`
 * @param {string} service - The Service this package is intended for.
 * Matching a valid return type from `vcs.determineProvider()` Eventually
 * this service will be detected by the package handler or moved here, but for now
 * is intended to be hardcoded as "git"
 * @returns {object} - Returns a Server Status Object, which when `ok: true`
 * Contains the full package data. This includes the Readme, the package.json, and all version data.
 * @todo Stop hardcoding the service that is passed here.
 */
async function newPackageData(userObj, ownerRepo, service) {
  try {
    let provider = null;
    // Provider above, is the provider that should be assigned to allow interaction
    // with our specific VCS service

    switch (service) {
      case "git":
      default:
        provider = new GitHub();
    }

    let newPack = {}; // We will append the new Package Data to this Object

    let exists = await provider.exists(userObj, ownerRepo);

    if (!exists.ok) {
      // Could be due to an error, or it doesn't exist at all.
      // For now until we support custom error messages will do a catch all
      // return.
      return {
        ok: false,
        content: `Failed to get repo: ${ownerRepo} - ${exists.short}`,
        short: "Bad Repo",
      };
    }

    let pack = await provider.packageJSON(userObj, ownerRepo);

    if (!pack.ok) {
      return {
        ok: false,
        content: `Failed to get gh package for ${ownerRepo} - ${pack.short}`,
        short: "Bad Package",
      };
    }

    const tags = await provider.tags(userObj, ownerRepo);

    if (!tags.ok) {
      return {
        ok: false,
        content: `Failed to get gh tags for ${ownerRepo} - ${tags.short}`,
        short: "Server Error",
      };
    }

    // Build a repo tag object indexed by tag names so we can handle versions
    // easily, and won't call query.engine() multiple times for a single version.
    let tagList = {};
    for (const tag of tags.content) {
      if (typeof tag.name !== "string") {
        continue;
      }
      const sv = query.engine(tag.name.replace(semVerInitRegex, "").trim());
      if (sv !== false) {
        tagList[sv] = tag;
      }
    }

    // Now to get our Readme
    const readme = await provider.readme(userObj, ownerRepo);

    if (!readme.ok) {
      return {
        ok: false,
        content: `Failed to get gh readme for ${ownerRepo} - ${readme.short}`,
        short: "Bad Repo",
      };
    }

    // Now we should be ready to create the package.
    // readme = The text data of the current repo readme
    // tags = API JSON response for repo tags, including the tags, and their
    //        sha hash, and tarball_url
    // pack = the package.json file within the repo, as JSON
    // And we want to funnel all of this data into newPack and return it.

    // First we ensure the package name is in the lowercase format.
    const packName = pack.content.name.toLowerCase();

    newPack.name = packName;
    newPack.creation_method = "User Made Package";
    newPack.readme = readme.content;
    newPack.metadata = pack.content; // The metadata tag is the most recent package.json

    // Then lets add the service used, so we are able to safely find it in the future
    const packRepoObj = determineProvider(pack.content.repository);
    newPack.repository = packRepoObj;

    // Now during migration packages will have a `versions` key, but otherwise
    // the standard package will just have `version`
    // We build the array of available versions extracted form the package object.
    let versionList = [];
    if (pack.content.versions) {
      for (const v of Object.keys(pack.content.versions)) {
        versionList.push(v);
      }
    } else if (pack.content.version) {
      versionList.push(pack.content.version);
    }

    let versionCount = 0;
    let latestVersion = null;
    let latestSemverArr = null;
    newPack.versions = {};
    // Now to add the release data of each release within the package
    for (const v of versionList) {
      const ver = query.engine(v.replace(semVerInitRegex, ""));
      if (ver === false) {
        continue;
      }

      let tag = tagList[ver];
      if (tag === undefined) {
        continue;
      }

      // They match tag and version, stuff the data into the package

      if (typeof tag === "string") {
        for (const t of tags.content) {
          if (typeof t.name !== "string") {
            continue;
          }
          const sv = query.engine(t.name.replace(semVerInitRegex, "").trim());
          if (sv === tag) {
            tag = t;
            break;
          }
        }
      }

      if (!tag.tarball_url) {
        logger.generic(
          3,
          `Cannot retreive metadata info for version ${ver} of packName`
        );
        continue;
      }

      pack.content.tarball_url = tag.tarball_url;
      pack.content.sha =
        typeof tag.commit?.sha === "string" ? tag.commit.sha : "";

      newPack.versions[ver] = pack.content;
      versionCount++;

      // Check latest version
      if (latestVersion === null) {
        // Initialize latest versin
        latestVersion = ver;
        latestSemverArr = utils.semverArray(ver);
        continue;
      }

      const sva = utils.semverArray(ver);
      if (utils.semverGt(sva, latestSemverArr)) {
        latestVersion = ver;
        latestSemverArr = sva;
      }
    }

    if (versionCount === 0) {
      return {
        ok: false,
        content: "Failed to retreive package versions.",
        short: "Server Error",
      };
    }

    // Now with all the versions properly filled, we lastly just need the
    // release data
    newPack.releases = {
      latest: latestVersion,
    };

    // For this we just use the most recent tag published to the repo.
    // and now the object is complete, lets return the pack, as a Server Status Object.
    return {
      ok: true,
      content: newPack,
    };
  } catch (err) {
    // An error occured somewhere during package generation
    return {
      ok: false,
      content: err,
      short: "Server Error",
    };
  }
}

/**
 * @async
 * @function newVersionData
 * @desc Replaces the previously used `git.metadataAppendTarballInfo()`
 * Intended to retreive the most basic of a package's data.
 * Bundles all the special handling of crafting such an object into this single
 * function to reduce usage elsewhere.
 * @param {object} userObj - The Full User Object as returned by `auth.verifyAuth()`
 * @param {string} ownerRepo - The Owner Repo Combo of the package affected.
 * Such as `pulsar-edit/pulsar`
 * @param {string} service - The service to use as expected to be returned
 * by `vcs.determineProvider()`. Currently should be hardcoded to "git"
 * @returns {SSO_VCS_newVersionData} A Server Status Object, which when `ok: true`
 * returns all data that would be needed to update a package on the DB, and
 * upload a new version.
 */
async function newVersionData(userObj, ownerRepo, service) {
  // Originally when publishing a new version the responsibility to collect
  // all package data fell onto the package_handler itself
  // Including collecting readmes and tags, now this function should encapsulate
  // all that logic into a single place.

  let provider = null;
  // Provider above, is the provider that should be assigned to allow interaction
  // with our specific VCS service

  switch (service) {
    case "git":
    default:
      provider = new GitHub();
  }

  let pack = await provider.packageJSON(userObj, ownerRepo);

  if (!pack.ok) {
    return {
      ok: false,
      content: `Failed to get gh package for ${ownerRepo} - ${pack.short}`,
      short: "Bad Package",
    };
  }

  // Now we will also need to get the packages data to update on the DB
  // during verison pushes.

  let readme = await provider.readme(userObj, ownerRepo);

  if (!readme.ok) {
    return {
      ok: false,
      content: `Failed to get gh readme for ${ownerRepo} - ${readme.short}`,
      short: "Bad Repo",
    };
  }

  let tag = null;

  if (typeof pack.content.version === "object") {
    tag = pack.content.version;
  }

  if (typeof pack.content.version === "string") {
    // Retreive tag object related to our tagged version string
    const tags = await provider.tags(userObj, ownerRepo);

    if (!tags.ok) {
      return {
        ok: false,
        content: `Failed to get gh tags for ${ownerRepo} - ${tags.short}`,
        short: "Server Error",
      };
    }

    for (const t of tags.content) {
      if (typeof t.name !== "string") {
        continue;
      }
      const sv = query.engine(t.name.replace(semVerInitRegex, "").trim());
      if (sv === pack.content.version.replace(semVerInitRegex, "").trim()) {
        tag = t;
        break;
      }
    }

    if (tag === null) {
      // If we couldn't find any valid tags that match the tag currently available
      // on the remote package.json
      return {
        ok: false,
        content: `Failed to find a matching tag: ${ownerRepo} - ${pack.content.version}`,
        short: "Server Error",
      };
    }
  }

  if (!tag.tarball_url) {
    logger.generic(
      3,
      `Cannot retreive metadata information for version ${ver} of ${ownerRepo}`
    );
    return {
      ok: false,
      content: `Failed to find any valid tag data for: ${ownerRepo} - ${tag}`,
      short: "Server Error",
    };
  }

  pack.content.tarball_url = tag.tarball_url;
  pack.content.sha = typeof tag.commit?.sha === "string" ? tag.commit.sha : "";

  return {
    ok: true,
    content: {
      name: pack.content.name.toLowerCase(),
      repository: determineProvider(pack.content.repository),
      readme: readme.content,
      metadata: pack.content,
    },
  };
}

/**
 * @function determineProvider
 * @desc Determines the repostiry object by the given argument.
 * Takes the `repository` key of a `package.json` and with very little if not no
 * desctructing will attempt to locate the provider service and return an object
 * with it.
 * @param {string|object} repo - The `repository` of the retrieved package.
 * @returns {object} The object related to the package repository type.
 */
function determineProvider(repo) {
  try {
    // First party packages do already have the regular package object.
    // So we will need to check if it's an object or string.
    if (repo === null || repo === undefined) {
      return {
        type: "na",
        url: "",
      };
    }

    // If not null, it's likely a first party package
    // With an already valid package object that can just be returned.
    if (typeof repo === "object") {
      return repo;
    }

    if (typeof repo !== "string") {
      return {
        type: "unknown",
        url: repo,
      };
    }

    // The repo is a string, and we need to determine who the provider is.
    const lcRepo = repo.toLowerCase();

    switch (true) {
      case lcRepo.includes("github"):
        return {
          type: "git",
          url: repo,
        };

      case lcRepo.includes("bitbucket"):
        return {
          type: "bit",
          url: repo,
        };

      case lcRepo.includes("sourceforge"):
        return {
          type: "sfr",
          url: repo,
        };

      case lcRepo.includes("gitlab"):
        return {
          type: "lab",
          url: repo,
        };

      case lcRepo.includes("codeberg"):
        return {
          type: "berg",
          url: repo,
        };

      default:
        // If no other recognized matches exist, return repo with na service provider.
        return {
          type: "unknown",
          url: repo,
        };
    }
  } catch (err) {
    return {
      type: "na",
      url: "",
    };
  }
}

module.exports = {
  determineProvider,
  ownership,
  newPackageData,
  newVersionData,
};
