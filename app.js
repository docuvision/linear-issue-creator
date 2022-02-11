const core = require('@actions/core');
const github = require('@actions/github');
const linear = require("@linear/sdk");
const retry = require('async-retry');

let statesCache = {};
let stateIds = {};

const github_token = core.getInput('GITHUB_TOKEN');
const octokit = new github.GitHub(github_token);

const linearKey = core.getInput('linear-key');
const linearClient = new linear.LinearClient({ 'apiKey': linearKey }); // process.env.LINEAR_API_KEY
const initialIssueState = core.getInput('issue-state');
const issueLabel = core.getInput('issue-label');
const dueInDays = parseInt(core.getInput('due-in-days'));
const issuePriority = parseInt(core.getInput('priority'));
const issueEstimate = parseInt(core.getInput('estimate'));
const debug = core.getInput('debug') === 'true';

// map of GH user to Linear display user
const userMap = {
  // GH -> Linear
  'teebu': 'yuriy',
  'juviwhale': 'juviwhale',
  'thisFunction': 'adam',
  'dani3lsz': 'dani3lsz',
  'to-ph': 'to-ph',
  'caerulescens': 'caerulescens',
  'jernejc': 'jernej',
  'tigrankh': 'tigran',
  'Naltharial': 'primoz',
  'MHafez': 'mahmoud',
  'roman-right': 'roman',
  'dubbalubagis': 'tyler',
  'asemOT': 'asem',
  'skaterdav85': 'dtang',
  'jkantner': 'jkantner',
};

const payload = JSON.stringify(github.context.payload, undefined, 2);
if (debug) console.log(payload);

// fill in values from payload
const gh_action = github.context.payload.action; // labeled, unlabeled, (no label in root) closed, opened, reopened
const gh_label = github.context.payload.label && github.context.payload.label.name || null; // 'review_req_dani3lsz'
const branch = github.context.payload.pull_request && github.context.payload.pull_request.head && github.context.payload.pull_request.head.ref; // feature/fe-2379-testing-fe-linear
const reviewState = github.context.payload.review && github.context.payload.review.state; // approved, commented, changes_requested

const isMerged = !!(github.context.payload.pull_request && github.context.payload.pull_request.merged);
const merged_at = github.context.payload.pull_request && github.context.payload.pull_request.merged_at;

const pull_request_number = github.context.payload.pull_request && github.context.payload.pull_request.number;
const pull_request_labels = github.context.payload.pull_request && github.context.payload.pull_request.labels;
const usernameFromSender = github.context.payload.sender && github.context.payload.sender.login;
const linearUsernameFromSender = userMap[usernameFromSender] || usernameFromSender; // convert GH username to Linear display name
const usernameFromRequestedReviewer = github.context.payload.requested_reviewer && github.context.payload.requested_reviewer.login;
const linearUsernameFromRequestedReviewer = userMap[usernameFromRequestedReviewer] || usernameFromRequestedReviewer;  // convert GH username to Linear display name

const prTitle = github.context.payload.pull_request && github.context.payload.pull_request.title;
const prNumber = github.context.payload.number;
const prHtmlUrl = github.context.payload.pull_request && github.context.payload.pull_request.html_url;
const prBody = github.context.payload.pull_request && github.context.payload.pull_request.body || 'No description provided.';
const additions = github.context.payload.pull_request && github.context.payload.pull_request.additions;
const deletions = github.context.payload.pull_request && github.context.payload.pull_request.deletions;
const commits = github.context.payload.pull_request && github.context.payload.pull_request.commits;
const changedFiles = github.context.payload.pull_request && github.context.payload.pull_request.changed_files;
const prCreatedAt = github.context.payload.pull_request && github.context.payload.pull_request.created_at; // '2021-10-14T15:43:54Z'
const changes = additions + deletions || 0;
const prSize = getSizeOfPR(changes);
const prUser = github.context.payload.pull_request && github.context.payload.pull_request.user && github.context.payload.pull_request.user.login;
const linearUsernameFromPrUser = userMap[prUser] || prUser;  // convert GH username to Linear display name

let activityLogMessage = null;

// ACTIONS: labeled, unlabeled, closed (no label in root), submitted (no label in root)
// {
//   "action": "unlabeled",
//   "label": {
//     "default": true,
//     "description": "Improvements or additions to documentation",
//     "name": "documentation",
//     "node_id": "MDU6TGFiZWwzMjU0MTE5MzIx",
// },

async function main() {
  const issueId = parse_ref(branch);
  console.log('issueId:', issueId);
  console.log('gh_action:', gh_action);
  console.log('reviewState:', reviewState);
  console.log('isMerged:', isMerged);

  if (!issueId) {
    console.log('Unable to detect issueId from branch name');
    return;
  }

  const issue = await linearClient.issue(issueId);
  console.log('parent issue title:', issue.title);

  const _teamId = issue._team.id;
  const _parentId = issue.id;
  const _cycleId = issue._cycle && issue._cycle.id || null;

  let desiredState;
  // if gh_action closed and !isMerged set all issues to 'Canceled'
  // if gh_action closed we set all issues to 'Done'
  // if gh_action submitted and reviewState === 'approve' we set to 'Done' for sender's username
  // if gh_action submitted and reviewState === 'changes requested' we set to 'Changes Requested' for sender username
  // all others set to initial state defined in action (Todo)
  if (gh_action === 'closed' && !isMerged) {
    desiredState = 'Canceled';
  } else if (gh_action === 'closed') {
    desiredState = 'Done';
  } else if (reviewState === 'approved') {
    desiredState = 'Done';
  } else if (reviewState === 'changes_requested') {
    desiredState = 'Changes Requested';
  } else if (gh_action === 'review_requested') {
    desiredState = initialIssueState;
  } else {
    desiredState = initialIssueState;
  }

  // check label from action
  let usernameFoundInRootLabel = true;
  let username = parse_user_label(gh_label); // 'review_req_yuriy' - linear display names
  console.log(`gh_label username: ${username} from: ${gh_label}`);

  // handle 'labeled': skip task if no user found in current action label
  // note: only labeled action has the label data in root
  if ((gh_action === 'labeled' || gh_action === 'unlabeled') && !username) {
    console.log('no user found in labeled action, not a good lable. exiting action');
    return;
  }

  // if we can't get username from 'labeled/unlabeled' action's root label then look into action sender username
  if (!username) {
    usernameFoundInRootLabel = false;
    console.log('gh_label username not detected, falling back to gh action sender login username');
    console.log(`sender username: ${usernameFromSender} -> linear username: ${linearUsernameFromSender}`);
    username = linearUsernameFromSender;
  }

  if (linearUsernameFromRequestedReviewer && gh_action === 'review_requested') {
    usernameFoundInRootLabel = false;
    console.log('gh_action is review_requested, will use username from requested_reviewer login username');
    console.log(`review_requested username: ${usernameFromRequestedReviewer} -> linear username: ${linearUsernameFromRequestedReviewer}`);
    username = linearUsernameFromRequestedReviewer;
    // logging message
    activityLogMessage = `> **⚡ →** **@${linearUsernameFromSender}** 🙋🏻‍♂️requested a review from **@${linearUsernameFromRequestedReviewer}**`;
  }

  // find the linear user by username
  const user = await linearUserFind(username);
  let userId = user && user.id; // userId is null if not found
  console.log(`linear username: ${username} -> userId: ${userId}`);

  if (!userId) {
    throw new Error(`user id not found for ${username}`);
  }

  // ### logging messages
  // handle 'unlabeled': cancel the issue
  if (gh_action === 'unlabeled' && usernameFoundInRootLabel && userId) {
    console.log('user found and unlabeled action, going to cancel the issue');
    desiredState = 'Canceled'; // Cancel the issue
    activityLogMessage = `> **⚡ →** **@${linearUsernameFromSender}** 🌊 has **removed** review request label for **@${username}**`;
  }

  // handle 'labeled' event with valid user found in label
  if (gh_action === 'labeled' && usernameFoundInRootLabel && userId) {
    activityLogMessage = `> **⚡ →** **@${linearUsernameFromSender}** 🙋🏻‍♂️has **added** review request label for **@${username}**`;
  }

  // handle reviewState
  if (reviewState === 'approved' || reviewState === 'changes_requested' && linearUsernameFromSender) {
    let _action;
    if (reviewState === 'approved') _action = '👍 approved';
    else if (reviewState) _action = '🚼 requested changes';
    activityLogMessage = `> **⚡ →** **@${linearUsernameFromSender}** has **${_action}** the PR`;
  }

  // handle gh_action closed, reopened
  if (gh_action === 'closed' || gh_action === 'reopened') {
    let _action;

    if (gh_action === 'reopened') _action = '📂 reopened';
    else if (gh_action === 'closed') _action = isMerged ? '🧬 merged/closed' : '❌ ~~cancelled~~';

    activityLogMessage = `> **⚡ →** **@${linearUsernameFromSender}** has **${_action}** the PR`;
  }


  console.log('usernameFoundInRootLabel:', usernameFoundInRootLabel);
  console.log('desiredState:', desiredState);

  const desiredStateId = await getStateId(_teamId, desiredState); // get the id state
  stateIds.Done = await getStateId(_teamId, 'Done'); // get the id state
  stateIds.Canceled = await getStateId(_teamId, 'Canceled'); // get the id state

  const labelId = await getLabelId(_teamId, issueLabel); // in this team, get label id for string "PR Review"

  let cleanIssueTitle = branch.replace(/feature\/([a-z]{2,3}-\d+)\b-?/ig, '').replace(/-/g, ' ');
  let createIssueTitle = `🕵🏽‍♂️ PR Review -> ${cleanIssueTitle}`;
  createIssueTitle = createIssueTitle.replace(/ +(?= )/g, '').trim(); // cleanup spaces
  console.log(`sub issue title: ${createIssueTitle}`);

  const description = `
> # **${prSize.toUpperCase()}** → ${prTitle}  
> #### Review Requested by **${linearUsernameFromSender}**

#### PR Summary

* \`PR #:\` [${prNumber}](${prHtmlUrl})
* \`Created:\` **${humanReadableDate(prCreatedAt)}**
* \`PR Authors:\` ***${linearUsernameFromPrUser}***
* \`Review Requested at:\` **${humanReadableDate()}**
* \`Review Requester:\` ***${linearUsernameFromSender}***
* \`Size:\` ***${prSize}***
  * \`# of Commits:\` ***${commits}***
  * \`# of Changed Files:\` ***${changedFiles}***
  * \`# of Lines Added:\` ***${additions}***
  * \`# of Lines Removed:\` ***${deletions}***

-------------------------------------------------------------
[${prTitle}](${prHtmlUrl})

${prBody}
`;

  let dueDay = new Date(new Date());
  dueDay.setDate(dueDay.getDate() + dueInDays);
  if (!dueInDays || dueDay <= 0) dueDay = null;

  // set parent issue state if 'Changes Requested' in reviewState
  if (desiredState === 'Changes Requested') {
    console.log('setting parent issue to Changes Requested');
    await setIssueStateId(_parentId, desiredStateId);
  }

  // find issue with title and parentId and userId
  const foundIssues = await linearIssueFind(createIssueTitle);
  const filteredIssuesByParent = linearIssueFilter(foundIssues, _parentId);
  const filteredIssuesByUserId = linearIssueFilter(foundIssues, _parentId, userId);

  // sub issue settings
  const options = {
    title: createIssueTitle, teamId: _teamId, parentId: _parentId, cycleId: _cycleId,
    desiredStateId: desiredStateId, labelId: labelId,
    priority: issuePriority, estimate: issueEstimate, dueDate: dueDay
  };

  // only set description for PRs that contain PR data
  // triggers that have this data: synchronized, edited, opened, labeled, unlabeled
  if (commits > 0 && additions >= 0 && deletions >= 0) {
    options.description = description;
  }

  // if issue doesn't exist with that userId assigned and it obtained username from labeled event or sender's login, create sub issue
  if (filteredIssuesByUserId.length === 0 && userId && (usernameFoundInRootLabel === true || reviewState === 'approved' || reviewState === 'changes_requested')) {
    // create new issue only if userId is found in labeled event
    // or if a user approved or requested_changes  (name obtained from sender's login username)
    console.log('creating new issue');
    options.assigneeId = userId; // assign issue to userId
    let createPayload = await createIssue(options);

    const createdIssueInfo = await linearIssueGet(createPayload._issue.id);
    console.log(`createdIssue url: ${createdIssueInfo.url} for username: ${username}`,);
    core.setOutput("url", createdIssueInfo.url); // return url as output from action

    // add comment of linear url in the current PR if opened or reopened action
    const new_comment = await octokit.issues.createComment({
      ...github.context.repo, issue_number: pull_request_number,
      body: `[🕵🏽‍♂️ A new Linear issue was created for PR Review for ${username}](${createdIssueInfo.url})`
    });

    // add comment in created issue from activity log
    await createComment(createPayload._issue.id, activityLogMessage);

  } else if (filteredIssuesByParent.length > 0 && (gh_action === 'closed' || gh_action === 'reopened')) {
    // set desired state id for all the sub issues when PR is closed or reopened
    console.log(`${filteredIssuesByParent.length} issues found, going to update them to ${desiredState} if needed`);
    await updateIssues(filteredIssuesByParent, options, activityLogMessage);

  } else if (filteredIssuesByUserId.length > 0 && userId) {
    // if issue exists update issue with new assignee's id or if the issue state is different then desired
    console.log(`${filteredIssuesByUserId.length} issues found, going to update them to ${desiredState} if needed`);
    await updateIssues(filteredIssuesByUserId, options, activityLogMessage);

  } else {
    console.log('do nothing');
  }

    // create comment in main PR linear ticket with
    // include: Merge date, Merge Commit name/link, Merged by, PR description at that point
  if (gh_action === 'closed' && isMerged) {
    const comment = `
> # [${prTitle}](${prHtmlUrl})
> **@${linearUsernameFromSender}** has **🧬 merged** the PR
> ${humanReadableDate()}

${prBody}
`;
    await createComment(_parentId, comment);
  }

  console.log('done');
}

async function createIssue({
                             title, teamId, parentId, cycleId, description, assigneeId, desiredStateId,
                             labelId, priority, estimate, dueDate
                           }) {
  // Create a subissue for label and assignee
  const options = {
    title, teamId, parentId, cycleId, description, priority, estimate, dueDate,
    stateId: desiredStateId, // issue status (ie: QA)
    labelIds: [labelId],
  };

  if (assigneeId) options.assigneeId = assigneeId;              // assign the user if found
  if (assigneeId === 'unassigned') options.assigneeId = null;   // unassign user by passing null, otherwise don't change current user

  console.log('createIssue payload:', JSON.stringify(options));


  const createPayload = await linearClient.issueCreate(options);

  if (createPayload.success) {
    console.log(createPayload);
    return createPayload;
  } else {
    return new Error("Failed to create issue");
  }
}

async function updateIssue(id, {
  title, teamId, parentId, cycleId, description, assigneeId, desiredStateId, labelId, priority, estimate, dueDate
}) {

  const options = {
    title, teamId, parentId, cycleId, description, priority, estimate, dueDate,
    stateId: desiredStateId, // issue status
    labelIds: [labelId],
  };

  // assign the user if found otherwise retain assigned user
  if (assigneeId) options.assigneeId = assigneeId;

  console.log('updateIssue payload:', JSON.stringify(options));

  const createPayload = await linearClient.issueUpdate(id, options);

  if (createPayload.success) {
    console.log(createPayload);
    return createPayload;
  } else {
    return new Error("Failed to update issue");
  }
}

async function setIssueStateId(id, desiredStateId) {
  // update the state of for issue by id
  const options = {
    stateId: desiredStateId, // state id that represents a string (Changes Requested)
  };

  console.log('setIssueStatus payload:', JSON.stringify(options));

  const updatePayload = await linearClient.issueUpdate(id, options);

  if (updatePayload.success) {
    console.log(updatePayload);
    return updatePayload;
  } else {
    return new Error("Failed to update issue");
  }
}

async function setIssuesStateId(issues, desiredStateId) {
  // not used - loop for each issue and update state ids
  for (const issue of issues) {
    if (issue._state.id === stateIds.Done) { // probably dont want this anymore
      // console.log(`${issue._state.id} not going to change, already done`);
      console.log(`issue was Done. Updating it to: ${issue._state.id}`);
      await setIssueStateId(issue.id, desiredStateId);
    } else {
      await setIssueStateId(issue.id, desiredStateId);
    }
  }
}

async function updateIssues(issues, options, activityLogMessage = null) {
  // update all issues found with same data from PR if updates needed
  for (const issue of issues) {
    if (issue._state.id === stateIds.Done) {
      // console.log(`${issue._state.id} not going to change, already done`);
      console.log(`issue was Done. Updating it to: ${issue._state.id}`);
      await updateIssue(issue.id, options);
    } else if (issue._state.id !== options.desiredStateId) {
      console.log(`updating: ${issue._state.id}`);
      await updateIssue(issue.id, options);
    }

    if (activityLogMessage) {
      await createComment(issue.id, activityLogMessage);
    }
  }
}

async function linearIssueFind(title) {
  const { nodes: found } = await linearClient.issueSearch(title);
  return found;
}

function linearIssueFilter(linearIssues = [], parentId, userId = null) {
  return linearIssues.filter((issue) => {
    if (userId) {
      return issue._parent && issue._parent.id === parentId && issue._assignee.id === userId;
    } else {
      return issue._parent && issue._parent.id === parentId;
    }
  });
}

async function linearUserFind(userName) {
  if (!userName) userName = '';

  const { nodes: found } = await linearClient.users({
      includeArchived: false,
      first: 100,
      // filter: {
      //     displayName: { eq: userName }
      //   }
    }
  );
  if (found.length === 0) return null;

  return found.find((user) => user.displayName.toLowerCase() === userName.toLowerCase()) || null;
}

// parse title, body, ref of git pull request and get the 'doc-id'
function parse_ref(ref_head) {
  // the pull request GITHUB_REF "doc-490-evaluate-pull-request-deployment-of", "fe-4390-message"
  console.log('ref_head:', ref_head);

  if (!ref_head) return null;

  const re = /\b([a-z]{2,3}-\d+)\b/i;
  // console.log(ref_head.match(re));
  return ref_head.match(re) && ref_head.match(re)[0];
}


function parse_user_label(label) {
  // parse gh label for reviewed request
  // review_req_yuriy
  console.log('parsing label:', label);

  if (!label) return null;

  const re = /^review_req_(.*)/;
  // console.log(label.match(re));
  return label.match(re) && label.match(re)[1];
}

function findUserLabelInPR(labels) {
  // find first username assigned in PRs existing labels array
  let foundLabel = null;
  labels.some((label) => {
    let parsed_user = parse_user_label(label.name);
    if (parsed_user) {
      foundLabel = parsed_user;
      return true;
    }
  });
  return foundLabel;
}

async function getStateId(teamId, desiredState) {
  const availabelStatesInTeam = await linearWorkflowStatesList(teamId);
  const foundState = availabelStatesInTeam.find((state) => state.name === desiredState);
  if (!foundState) {
    throw new Error(`Not found state "${foundState}" in team ${teamId}`);
  }

  return foundState.id;
}

async function linearWorkflowStatesList(teamId) {
  // create a cache for states for team
  if (statesCache && statesCache[teamId] && statesCache[teamId].length > 0) {
    return statesCache[teamId];
  }
  const { nodes: states } = await linearClient.workflowStates({ first: 100 });
  const teamStates = (
    await Promise.all(
      states.map(async (state) => {
        const found = await state.team;
        if (found.id === teamId) {
          // There is state in required team
          return state;
        }
        return null;
      }),
    )
  ).filter((state) => state !== null);
  statesCache[teamId] = teamStates;
  return teamStates;
}

async function getLabelId(teamId, desiredLabel) {
  // get labels for team
  const team = await linearClient.team(teamId);
  const { nodes: labels } = await team.labels();
  label = labels.find((label) => label.name.toLowerCase() === desiredLabel.toLowerCase());
  if (!label) {
    throw new Error(`Not found label "${desiredLabel}" in team ${teamId}`);
  }

  return label.id;
}

async function createComment(issueId, body) {
  if (!issueId) {
    console.log('no issueId detected, skipping posting comment');
    return;
  }

  console.log('creating comment:', body);
  const commentPayload = await linearClient.commentCreate({ issueId, body });
  if (commentPayload.success) {
    console.log(await commentPayload.comment);

    return commentPayload.comment;
  } else {
    return new Error("Failed to create comment");
  }
}

async function linearIssueGet(issueId) {
  return await linearClient.issue(issueId);
}

function getSizeOfPR(changes) {
  // size determined by additions and deletions
  if (changes === 0) return '';

  if (changes < 20) {
    return 'Small';
  } else if (changes >= 20 && changes <= 100) {
    return 'Medium';
  } else if (changes > 100 && changes <= 200) {
    return 'Large';
  } else if (changes > 200) {
    return 'X-Large';
  } else { // fallback
    return '';
  }
}

function humanReadableDate(datestring) {
  const options = { year: "numeric", month: "long", day: "numeric" };
  if (datestring) return new Date(datestring).toLocaleDateString(undefined, options);
  else return new Date().toLocaleDateString(undefined, options);
}

// run main
// https://github.com/vercel/async-retry
(async () => {
  try {
    await retry(
      async (bail, num) => {
        // if anything throws, we retry
        console.log('attempt:', num);
        await main();
      },
      { retries: 2 }
    );
  }
  catch (error) {
    console.error('error from main:', error);
    core.setFailed(error);
    process.exit(-1);
  }
})();
