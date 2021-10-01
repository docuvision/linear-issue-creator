# Linear App Issue Creator github acton

This action creates an sub issue in a related linear ticket

## Inputs

### `linear-key`

**Required** The linear API key. Default ``.

## Outputs

### `url`

The time the ticket was created.

## Example usage

```
- name: Create Linear Issues
id: linear-issues-creator
uses: teebu/linear-issue-creator@master
with:
  linear-key: 1234567
```

## Tags:
git tag -a v1.0 -m "update version"
