/**
 * @module GitHub
 * @desc A VCS Module to allow `vcs.js` to interact with GitHub as needed. Utilizing `git.js`
 */

const Git = require("./git.js");
const utils = require("../utils.js");

class GitHub extends Git {
  constructor(opts) {

    super({
      api_url: opts.api_url ?? "https://api.github.com",
      ok_status: [200, 401]
    });
  }

  async ownership(user, pack) {
    // expects full userObj, and repoObj
    let ownerRepo = utils.getOwnerRepoFromPackage(pack.data);

    let owner = await this.doesUserHaveRepo(user.token, ownerRepo);

    if (owner.ok) {
      // We were able to confirm the ownership of the repo just fine and can return.
      return owner;
    }

    switch(owner.short) {
      case "No Access":
        // The user does not have any access to the repo.
        return { ok: false, short: "No Repo Access" };
      case "Bad Auth":
        // TODO: Properly handle token refresh
        return {
          ok: false,
          short: "Server Error",
          content: owner.short,
        };
      default:
        return {
          ok: false,
          short: "Server Error",
          content: owner.short
        };
    }
  }

  async doesUserHaveRepo(token, ownerRepo, page = 1) {
    try {
      let check = await this._webRequestAuth(`/user/repos?page=${page}`, token);

      if (!check.ok) {
        if (check.short === "Failed Request") {
          // This means the request failed with a non 200 HTTP Status Code.
          // Looking into the error could tell us if the token is expired or etc.
          switch(check.content.status) {
            case 401:
              return {
                ok: false,
                short: "Bad Auth"
              };
            default:
              return {
                ok: false,
                short: "Server Error"
              };
          }
        }
        // Otherwise the short is something else. Likely a server error, and
        // we will want to return a server error.
        return {
          ok: false,
          short: "Server Error"
        };
      }

      for (let i = 0; i < check.content.body.length; i++) {
        if (check.content.body[i].full_name === ownerRepo) {
          return {
            ok: true,
            content: check.content.body[i]
          };
        }
      }

      // After going through every repo returned, we haven't found a repo
      // that the user owns. Lets check if there's multiple pages of returns.
      const nextPage = page + 1;
      if (check.content.headers.link.includes(`?page=${nextPage}`)) {
        // We have another page available via the page headers
        // Lets call this again with the next page
        return await this.doesUserHaveRepo(token, ownerRepo, nextPage);
      }

      // There are no additional pages. Return that we don't have access
      return {
        ok: false,
        short: "No Access"
      };

    } catch(err) {
      // We encounted an exception that's not related to the webrequest.
      return {
        ok: false,
        short: "Server Error",
        content: err
      };
    }
  }
}

module.exports = GitHub;
