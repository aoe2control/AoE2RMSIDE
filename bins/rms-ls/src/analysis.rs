use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::Value;

use crate::{PublicationDraft, Server};

pub(crate) struct Job {
    id: u64,
    uri: String,
    cancel: Arc<AtomicBool>,
    server: Box<Server>,
    phase: JobPhase,
}

enum JobPhase {
    Strict,
    Lint(Box<PublicationDraft>),
    Finish(Box<PublicationDraft>),
    Done,
}

pub(crate) struct Analyzed {
    pub id: u64,
    pub publication: Option<Value>,
}

impl Job {
    pub(crate) fn step(&mut self) -> Option<Analyzed> {
        let ended = |publication| {
            Some(Analyzed {
                id: self.id,
                publication,
            })
        };
        if self.cancel.load(Ordering::Acquire) {
            self.phase = JobPhase::Done;
            return ended(None);
        }
        match std::mem::replace(&mut self.phase, JobPhase::Done) {
            JobPhase::Strict => match self.server.publication_strict(&self.uri) {
                Ok(draft) => self.phase = JobPhase::Lint(Box::new(draft)),
                Err(_) => return ended(None),
            },
            JobPhase::Lint(mut draft) => {
                self.server.publication_lint(&mut draft);
                self.phase = JobPhase::Finish(draft);
            }
            JobPhase::Finish(draft) => {
                return ended(Some(self.server.publication_finish(*draft)));
            }
            JobPhase::Done => return ended(None),
        }
        None
    }

    pub(crate) fn run(mut self) -> Analyzed {
        loop {
            if let Some(analyzed) = self.step() {
                return analyzed;
            }
        }
    }
}

struct Running {
    id: u64,
    uri: String,
    revision: u64,
    cancel: Arc<AtomicBool>,
}

pub(crate) enum Finished {
    Current(Value),
    Dropped,
}

#[derive(Default)]
pub(crate) struct Analysis {
    pending: VecDeque<(String, u64)>,
    running: Option<Running>,
    next_ticket: u64,
}

impl Analysis {
    pub(crate) fn queue(&mut self, uris: impl IntoIterator<Item = String>) {
        for uri in uris {
            if self.pending.iter().any(|(queued, _)| *queued == uri) {
                continue;
            }
            self.next_ticket += 1;
            self.pending.push_back((uri, self.next_ticket));
        }
    }

    pub(crate) fn observe(&mut self, server: &Server) {
        let Some(running) = &self.running else {
            return;
        };
        if running.revision == server.revision || running.cancel.load(Ordering::Acquire) {
            return;
        }
        running.cancel.store(true, Ordering::Release);
        let uri = running.uri.clone();
        self.queue([uri]);
    }

    pub(crate) fn dispatch(&mut self, server: &Server) -> Option<Job> {
        if self.running.is_some() {
            return None;
        }
        while let Some((uri, ticket)) = self.pending.pop_front() {
            if !server.documents.contains_key(&uri) {
                continue;
            }
            let cancel = Arc::new(AtomicBool::new(false));
            self.running = Some(Running {
                id: ticket,
                uri: uri.clone(),
                revision: server.revision,
                cancel: cancel.clone(),
            });
            return Some(Job {
                id: ticket,
                uri,
                cancel,
                server: Box::new(server.analysis_view()),
                phase: JobPhase::Strict,
            });
        }
        None
    }

    pub(crate) fn finished(&mut self, server: &Server, analyzed: Analyzed) -> Finished {
        let Some(running) = self.running.take_if(|running| running.id == analyzed.id) else {
            return Finished::Dropped;
        };
        if running.cancel.load(Ordering::Acquire) {
            return Finished::Dropped;
        }
        if running.revision != server.revision {
            self.queue([running.uri]);
            return Finished::Dropped;
        }
        match analyzed.publication {
            Some(publication) => Finished::Current(publication),
            None => Finished::Dropped,
        }
    }

    pub(crate) fn ticket(&self, uri: &str) -> Option<u64> {
        if let Some(running) = &self.running
            && running.uri == uri
            && !running.cancel.load(Ordering::Acquire)
        {
            return Some(running.id);
        }
        self.pending
            .iter()
            .find(|(queued, _)| queued == uri)
            .map(|(_, ticket)| *ticket)
    }

    pub(crate) fn holds(&self, ticket: u64) -> bool {
        self.running
            .as_ref()
            .is_some_and(|running| running.id == ticket && !running.cancel.load(Ordering::Acquire))
            || self.pending.iter().any(|(_, queued)| *queued == ticket)
    }

    pub(crate) fn idle(&self) -> bool {
        self.running.is_none() && self.pending.is_empty()
    }

    pub(crate) fn forget(&mut self, uri: &str) {
        self.pending.retain(|(queued, _)| queued != uri);
        if let Some(running) = &self.running
            && running.uri == uri
        {
            running.cancel.store(true, Ordering::Release);
        }
    }

    pub(crate) fn cancel_all(&mut self) {
        if let Some(running) = &self.running {
            running.cancel.store(true, Ordering::Release);
        }
        self.pending.clear();
    }
}
