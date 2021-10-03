# Linear App Issue Creator github acton

This action creates a linear sub issue that is related to a linear ticket for a PR.



## Inputs

### `linear-key`
**Required** The linear API key. Default `none`.

### `due-in-days`
Due in days. Default `1`.

### `issue-state`
Issue state (Todo). Default `Todo`.

### `issue-label`
Label assigned to issue (PR Review). Default `none`.

### `priority`
The linear API key. Default `2`.

### `estimate`
Issue estimate. Default `2`.

### `GITHUB_TOKEN`
**Required** Github Token. Default `none`.

### `debug`
The linear API key. Default `false`.


## Outputs

### `url`

The time the ticket was created.

## Example usage

```
name: Linear Issues Creator
on:
  pull_request:
    types: [labeled, unlabeled, closed, opened, reopened]
  pull_request_review:
    types: [submitted]

jobs:
  create-issue:
    runs-on: ubuntu-latest
    steps:
      - name: Linear Issues Creator
        id: linear-issues-creator
        uses: teebu/linear-issue-creator@master
        with:
          linear-key: ${{ secrets.LINEAR_API_KEY }}
          GITHUB_TOKEN: ${{ github.token }}
          debug: true
```

If the issue is in 'Done' state no action occurs.
If the issue is in 'Canceled' state, only a 'reopened' event will set it back to 'Todo'.

- action: created PR -> creates an unassigned sub issue when a PR is opened with default values and description
- action: labeled -> checks the label and if username is found then assigns that user to the sub issue 
- action: unlabeled -> removes an assignee from the issue
- action: closed PR -> sets 'Canceled' state on the sub issue
- action: closed PR with merge -> marks the sub issue 'QA'
- action: reviewed PR as 'approved' -> marks the sub issue 'QA'
- action: reviewed PR as 'changes_requested' -> marks sub issue and parent issue as 'Changes Requested'
- action: reopened a closed PR -> sub issue set to default state 'Todo'

## Release Tags:
```
git tag -a v1.0.1 -m "update version"  
git push origin v1.0.1
```
