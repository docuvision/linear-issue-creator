const core = require('@actions/core');
const github = require('@actions/github');
const linear = require("@linear/sdk");

let statesCache = {};

const github_token = core.getInput('GITHUB_TOKEN');
const octokit = new github.GitHub(github_token);

const linearKey = core.getInput('linear-key');
const linearClient = new linear.LinearClient({ 'apiKey': linearKey }); // process.env.LINEAR_API_KEY
const initialIssueState = core.getInput('issue-state');
const issueLabel = core.getInput('issue-label');
const dueInDays = parseInt(core.getInput('due-in-days'));
const issuePriority = parseInt(core.getInput('priority'));
const issueEstimate = parseInt(core.getInput('estimate'));
const debug = core.getInput('debug') == 'true' ? true : false;

const payload = JSON.stringify(github.context.payload, undefined, 2);
if (debug) console.log(payload);

// fill in values from payload
const gh_action = github.context.payload.action; // labeled, unlabeled, (no label in root) closed, opened, reopened
const gh_label = github.context.payload.label && github.context.payload.label.name || null; // 'review_req_dani3lsz'
const branch = github.context.payload.pull_request && github.context.payload.pull_request.head && github.context.payload.pull_request.head.ref; // feature/fe-2379-testing-fe-linear
const PRClosed = gh_action == 'closed' ? true : false;
const reviewState = github.context.payload.review && github.context.payload.review.state; // approved, commented, changes_requested
const isMerged = !!(github.context.payload.pull_request && github.context.payload.pull_request.merged);
const pull_request_number = github.context.payload.pull_request && github.context.payload.pull_request.number;
const pull_request_labels = github.context.payload.pull_request && github.context.payload.pull_request.labels;

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

  if (!issueId) {
    console.log('Unable to detect issueId from branch name');
    return;
  }

  const issue = await linearClient.issue(issueId);
  console.log(issue);

  const _teamId = issue._team.id;
  const _parentId = issue.id;
  const _cycleId = issue._cycle && issue._cycle.id || null;

  let desiredState;
  // if PRClosed we set to 'QA'
  // if PRClosed and !isMerged set to 'Canceled'
  // if reviewState == 'approve' we set to 'QA'
  // if reviewState == 'changes requested' we set to 'Changes Requested'
  // all others set to inital state defined in action (Todo)
  if (PRClosed && !isMerged) {
    desiredState = 'Canceled';
  } else if (PRClosed || reviewState == 'approved') {
    desiredState = 'QA';
  } else if (reviewState == 'changes_requested') {
    desiredState = 'Changes Requested';
  } else {
    desiredState = initialIssueState;
  }

  // check label from action
  let usernameFoundInRootLabel = true;
  const usernameFromLabel = parse_user_label(gh_label); // 'review_req_yuriy' - linear display names
  console.log(`gh_label username: '${usernameFromLabel}' from: '${gh_label}'`);

  // handle 'labeled': skip task if no user found in current action label
  // note: only labled action has the label data in root
  if ((gh_action == 'labeled' || gh_action == 'unlabeled') && !usernameFromLabel) {
    console.log('no user found in labeled action, not a good lable. exiting action');
    return;
  }

  // if we can't get username from 'labeled/unlabeled' action's root label then look into existing PR labels array
  if (!usernameFromLabel) {
    console.log('gh_label username not found, falling back to existing labels')
    usernameFoundInRootLabel = false;
    const assignedUserLabel = findUserLabelInPR(pull_request_labels);
    if (assignedUserLabel) {
      console.log(`existing labels username found in labels: '${assignedUserLabel}'`);
      usernameFromLabel = assignedUserLabel;

    }
  }

  // find the linear user by username
  const user = await linearUserFind(usernameFromLabel);
  let userId = user && user.id; // userId is null if not found
  console.log('userId:', userId);

  // handle 'unlabeled': unassign the user from the ticket if that root label contains an existing user
  if (gh_action == 'unlabeled' && usernameFoundInRootLabel && userId) {
    console.log('user found and unlabeled action, going to unassign them from issue');
    userId = 'unassigned';
  }

  console.log('desiredState:', desiredState);
  const desiredStateId = await getStateId(_teamId, desiredState); // get the id state
  const doneStateId = await getStateId(_teamId, 'Done'); // get the id state

  const labelId = await getLabelId(_teamId, issueLabel); // in this team, get label id for strng "PR Review"

  const createIssueTitle = `🍯 PR Review: ${branch}`;
  const description = `# [${github.context.payload.pull_request.title}](${github.context.payload.pull_request.html_url})
  *${github.context.payload.pull_request.created_at}*
  
  ${github.context.payload.pull_request.body}
  
  ----------------------------------------
  changed files: **${github.context.payload.pull_request.changed_files}**
  commits: **${github.context.payload.pull_request.commits}**
  `;

  let dueDay = new Date(new Date());
  dueDay.setDate(dueDay.getDate() + dueInDays);
  if (!dueInDays || dueDay <= 0) dueDay = null;

  // set parent issue state to Changes Requested if reviewState is 'Changes Requested'
  if (desiredState == 'Changes Requested') {
    await setIssueStatus(_parentId, desiredStateId);
  }

  // find issue with title and parent id
  const foundIssue = await linearIssueFind(createIssueTitle, _parentId);

  if (!foundIssue) {  // create new issue
    console.log('creating new issue');
    let createPayload = await createIssue(
      createIssueTitle, _teamId, _parentId, _cycleId, description, userId, desiredStateId, labelId, issuePriority, issueEstimate, dueDay
    );

    const createdIssueInfo = await linearIssueGet(createPayload._issue.id);
    console.log('createdIssue url:', createdIssueInfo.url);
    core.setOutput("url", createdIssueInfo.url); // return url as ouput from action

    // add comment of linear url in the current PR if opened or reopened action
    if (gh_action == 'opened' || gh_action == 'reopened') {
      const new_comment = await octokit.issues.createComment({
        ...github.context.repo, issue_number: pull_request_number,
        body: `[New Linear issue created for PR Review, please assign user label on the right 🤳](${createdIssueInfo.url})`
      });
    }

  } else if (doneStateId == foundIssue._state.id) { // if issue is in Done state, dont do anything to it
    console.log('issue in Done state, wont update it');

  } else if (foundIssue && (userId != (foundIssue._assignee && foundIssue._assignee.id) || foundIssue._state.id != desiredStateId)) {
    // if issue exists but assignee doesnt match, update issue with new assignee's id or if the issue state is different then desired Todo -> QA (keep user)
    console.log('issue already exists but needs updating, going to update it');
    let res = await updateIssue(
      foundIssue.id, createIssueTitle, _teamId, _parentId, _cycleId, description, userId,
      desiredStateId, labelId, issuePriority, issueEstimate, dueDay
    );

  } else {
    console.log('issue already exists, do nothing');
  }

  console.log('done');
}

async function createIssue(title, teamId, parentId, cycleId, description, assigneeId, desiredStateId, labelId, priority, estimate, dueDate) {
  // Create a subissue for label and assignee
  const options = {
    title, teamId, parentId, cycleId, description, priority, estimate, dueDate,
    stateId: desiredStateId, // issue status (ie: QA)
    labelIds: [labelId],
  };

  if (assigneeId) options.assigneeId = assigneeId;            // assign the user if found
  if (assigneeId == 'unassigned') options.assigneeId = null;  // unassign user by passing null, otherwise don't change current user

  const createPayload = await linearClient.issueCreate(options);

  if (createPayload.success) {
    console.log(createPayload);
    return createPayload;
  } else {
    return new Error("Failed to create issue");
  }
}

async function updateIssue(id, title, teamId, parentId, cycleId, description, assigneeId, desiredStateId, labelId, priority, estimate, dueDate) {

  const options = {
    title, teamId, parentId, cycleId, description, priority, estimate, dueDate,
    stateId: desiredStateId, // issue status
    labelIds: [labelId],
  };

  if (assigneeId) options.assigneeId = assigneeId;            // assign the user if found
  if (assigneeId == 'unassigned') options.assigneeId = null;  // unassign user by passing null, otherwise don't change current user

  console.log('updateIssue payload:', JSON.stringify(options));

  const createPayload = await linearClient.issueUpdate(id, options);

  if (createPayload.success) {
    console.log(createPayload);
    return createPayload;
  } else {
    return new Error("Failed to update issue");
  }
}

// update the state of for issue by id
async function setIssueStatus(id, desiredStateId) {
  const options = {
    stateId: desiredStateId, // issue status (Changes Reqested)
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

async function linearIssueFind(title, parentId) {
  const { nodes: found } = await linearClient.issueSearch(title);
  if (found.length === 0) return null;

  return found.find((issue) => issue._parent.id === parentId) || null;
}

function findUserLabelInPR(labels) {
  // find first username assigned in PRs existing labeles array
  let foundLabel = labels.find((label) => parse_user_label(label.name) != null);
  return foundLabel && foundLabel.name && parse_user_label(foundLabel.name) || null;
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

  return found.find((user) => user.displayName.toLowerCase() == userName.toLowerCase()) || null;
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

// parse gh label for reviewed request
function parse_user_label(label) {
  // review_req_yuriy
  console.log('label:', label);

  if (!label) return null;

  const re = /^review_req_(.*)/;
  console.log(label.match(re));
  return label.match(re) && label.match(re)[1];
}

async function getStateId(team, desiredState) {
  const availabelStatesInTeam = await linearWorkflowStatesList(team);
  const foundState = availabelStatesInTeam.find((state) => state.name === desiredState);
  if (!foundState) {
    throw new Error(`Not found state "${foundState}" in team ${team.name} ${team.key}`);
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
  statesCache[teamId.key] = teamStates;
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

async function linearIssueGet(issueId) {
  return await linearClient.issue(issueId);
}

// run main
main().catch((error) => {
  console.error(error);
  core.setFailed(error);
  process.exit(-1);
});
