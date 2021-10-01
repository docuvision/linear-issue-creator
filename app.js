const core = require('@actions/core');
const github = require('@actions/github');
const linear = require("@linear/sdk");

let statesCache = {};

const linearKey = core.getInput('linear-key');
const linearClient = new linear.LinearClient({ 'apiKey': linearKey }); // process.env.LINEAR_API_KEY
const dueInDays = parseInt(core.getInput('due-in-days'));
const initialIssueState = core.getInput('issue-state');
const issueLabel = core.getInput('issue-label');
const issuePriority = parseInt(core.getInput('priority'));
const issueEstimate = parseInt(core.getInput('estimate'));

const payload = JSON.stringify(github.context.payload, undefined, 2)
console.log(payload);

// fill in values from payload
const gh_action = github.context.payload.action; // labeled, unlabeled, closed (no label in root)
const gh_label = github.context.payload.label && github.context.payload.label.name || null; // 'review_req_dani3lsz'
//process.env.GITHUB_HEAD_REF == "refs/heads/feature/doc-490-evaluate-pull-request-deployment-of"
const branch = github.context.payload.pull_request && github.context.payload.pull_request.head && github.context.payload.pull_request.head.ref; // feature/fe-2379-testing-fe-linear
const PRClosed = gh_action == 'closed' ? true : false;
const reviewState = github.context.payload.review && github.context.payload.review.state; // approved, commented, changes_requested
const isMerged = !!(github.context.payload.pull_request && github.context.payload.pull_request.merged);
// const changesRequested = true; // does it have a trigger?

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
  // if PRClosed == true we set to 'QA'
  // if PRClosed and isMerged set to 'Canceled'
  // if reviewState == 'approve' we set to 'QA'
  // if reviewState == 'changes requested' we set to 'Todo'
  //
  if (PRClosed || reviewState == 'approved') {
    desiredState = 'QA';
  } else if (reviewState == 'changes_requested') {
    desiredState = 'Changes Requested';
  } else if (PRClosed && isMerged) {
    desiredState = 'Canceled';
  } else {
    desiredState = initialIssueState;
  }

  const desiredStateId = await getStateId(_teamId, desiredState); // get the id of that state

  const labelId = await getLabelId(_teamId, issueLabel); // in the team find get label id

  const createIssueTitle = `🤞 PR Review: ${branch}`;
  const description = `Hey, this is the description of my awesome new feature. Review it asap.
    Go here and review: https://github.com/docuvision/Redacted.ai/pull/1008`;
  const assignUser = parse_user_label(gh_label); // 'review_req_yuriy' - linear display names

  let dueDay = new Date(new Date());
  dueDay.setDate(dueDay.getDate() + dueInDays);
  if (!dueInDays || dueDay <= 0) dueDay = null;

  if (gh_action == 'labeled' && !assignUser) {
    console.log('no user found in label, not a good lable');
    return;
  }

  // find the user by string
  const user = await linearUserFind(assignUser);
  const userId = user.id;

  // find issue with title with parent id
  const foundIssue = await linearIssueFind(createIssueTitle, _parentId);

  if (!foundIssue) {  // create subissue
    console.log('creating new sub issue');
    await createIssue(createIssueTitle, _teamId, _parentId, _cycleId, description, userId, desiredStateId, labelId, issuePriority, issueEstimate, dueDay);

  } else if (foundIssue && (userId != foundIssue._assignee.id || foundIssue._state.id != desiredStateId)) {
    // if issue exists but assignee doesnt match, update issue with new assignee's id or if the issue state is different then desired Todo -> QA
    console.log('sub issue already there, going to update it');
    await updateIssue(foundIssue.id, createIssueTitle, _teamId, _parentId, _cycleId, description, userId, desiredStateId, labelId, issuePriority, issueEstimate, dueDay);

  } else {
    console.log('sub issue already exists');
  }

  console.log('done');
}

async function createIssue(title, teamId, parentId, cycleId, description, assigneeId, desiredStateId, labelId, priority, estimate, dueDate) {
  // Create a subissue for label and assignee

  const createPayload = await linearClient.issueCreate(
    {
      title, teamId, parentId, cycleId, description, assigneeId, priority, estimate, dueDate,
      stateId: desiredStateId, // issue status
      labelIds: [labelId],
    });

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
  }

  // add assigneeId only if we pass, otherwise keep the same assignee
  if (assigneeId) options.assigneeId = assigneeId;

  const createPayload = await linearClient.issueUpdate(id, options);

  if (createPayload.success) {
    console.log(createPayload);
    return createPayload;
  } else {
    return new Error("Failed to update issue");
  }
}

async function linearIssueFind(title, parentId) {
  const { nodes: found } = await linearClient.issueSearch(title);
  if (found.length === 0) return null;

  return found.find((issue) => issue._parent.id === parentId) || null;
}

async function linearUserFind(userName) {
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
  // console.log(label.match(re));
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

// run main
main().catch((error) => {
  console.error(error);
  core.setFailed(error);
  process.exit(-1);
});
