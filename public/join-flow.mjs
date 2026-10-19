export const JOIN_STATUS = Object.freeze({
  CHECKING: "checking",
  AUTHENTICATED: "authenticated",
  UNAUTHENTICATED: "unauthenticated",
});

export function createJoinFlow(onStatusChange = () => {}) {
  let status = JOIN_STATUS.UNAUTHENTICATED;
  let generation = 0;

  const transition = (next) => {
    status = next;
    onStatusChange(next);
  };
  const isCurrent = (attempt) => attempt === generation && status === JOIN_STATUS.CHECKING;

  return {
    get status() { return status; },
    begin() {
      if (status === JOIN_STATUS.CHECKING) return null;
      generation += 1;
      transition(JOIN_STATUS.CHECKING);
      return generation;
    },
    isCurrent,
    authenticate(attempt) {
      if (!isCurrent(attempt)) return false;
      transition(JOIN_STATUS.AUTHENTICATED);
      return true;
    },
    reject(attempt) {
      if (!isCurrent(attempt)) return false;
      transition(JOIN_STATUS.UNAUTHENTICATED);
      return true;
    },
    invalidate() {
      generation += 1;
      transition(JOIN_STATUS.UNAUTHENTICATED);
    },
  };
}
